import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { compareHex64Asc, normalizeHex64 } from '../core/hexIds.mjs'
import { normalizeTcpPort } from '../core/tcp_port.mjs'
import { sha256Hex, keyPairFromSeed } from '../crypto/crypto.mjs'
import { noteAdvertPeerHints } from '../discovery/advert_peer_hints.mjs'
import { advertiseTopic, listenSignals, listDiscoveryProviders, registerDiscoveryProvider, sendSignal, subscribeTopic } from '../discovery/index.mjs'
import { createMdnsDiscoveryProvider } from '../discovery/mdns.mjs'
import { mergeSignalingRelayUrls, createNostrDiscoveryProvider } from '../discovery/nostr.mjs'
import { buildSignedAdvert, verifySignedAdvert } from '../link/handshake.mjs'
import { createBleGattLinkProvider } from '../link/providers/ble_gatt.mjs'
import {
	listAvailableLinkProviders,
	listLinkProviders,
	registerLinkProvider,
	unregisterLinkProvider,
} from '../link/providers/index.mjs'
import { createLanTcpLinkProvider } from '../link/providers/lan_tcp.mjs'
import { createWebRtcLinkProvider } from '../link/providers/webrtc.mjs'
import { ensureNodeSeed, getNodeHash, getNodeTransportSettings } from '../node/identity.mjs'
import { getSignalingRuntimeConfig } from '../node/instance.mjs'
import { createOverlayRouter } from '../overlay/index.mjs'
import { createLruMap } from '../utils/lru.mjs'

import { DEFAULT_ICE_SERVERS } from './ice_servers.mjs'

const SIGNAL_DOMAIN = 'fount-signal'
const NODE_TOPIC_DOMAIN = 'fount-rdv-node:'
const GROUP_TOPIC_DOMAIN = 'fount-rdv-group:'

/**
 * 由 nodeHash 派生节点 rendezvous topic。
 * @param {string} nodeHash 节点 64 hex
 * @returns {string} rendezvous topic 哈希
 */
export function nodeRendezvousTopic(nodeHash) {
	return sha256Hex(`${NODE_TOPIC_DOMAIN}${normalizeHex64(nodeHash)}`)
}

/**
 * 由房间密钥派生群组 rendezvous topic。
 * @param {string} roomSecret 房间密钥
 * @returns {string} rendezvous topic 哈希
 */
export function groupRendezvousTopic(roomSecret) {
	return sha256Hex(`${GROUP_TOPIC_DOMAIN}${String(roomSecret || '')}`)
}

/**
 * 由 topic 派生信令 AES 密钥。
 * @param {string} topic rendezvous 主题
 * @returns {Buffer} AES-256 密钥
 */
function signalKeyForTopic(topic) {
	return createHash('sha256').update(`${SIGNAL_DOMAIN}:${String(topic)}`).digest()
}

/**
 * 加密信令包为 AES-GCM 字节序列。
 * @param {string} topic rendezvous 主题
 * @param {unknown} packet 待加密 JSON 对象
 * @returns {Uint8Array} 加密后的字节
 */
export function encryptSignalPacket(topic, packet) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', signalKeyForTopic(topic), iv)
	const ciphertext = Buffer.concat([
		cipher.update(Buffer.from(JSON.stringify(packet), 'utf8')),
		cipher.final(),
	])
	return Buffer.from(JSON.stringify({
		iv: iv.toString('base64'),
		authTag: cipher.getAuthTag().toString('base64'),
		ciphertext: ciphertext.toString('base64'),
	}))
}

/**
 * 解密信令包；失败时返回 null。
 * @param {string} topic rendezvous 主题
 * @param {Uint8Array} bytes 加密字节
 * @returns {object | null} 解密后的 JSON 对象
 */
export function decryptSignalPacket(topic, bytes) {
	try {
		const payload = JSON.parse(Buffer.from(bytes).toString('utf8'))
		const decipher = createDecipheriv(
			'aes-256-gcm',
			signalKeyForTopic(topic),
			Buffer.from(payload.iv, 'base64'),
		)
		decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'))
		const plain = Buffer.concat([
			decipher.update(Buffer.from(payload.ciphertext, 'base64')),
			decipher.final(),
		])
		return JSON.parse(plain.toString('utf8'))
	}
	catch {
		return null
	}
}

/**
 * 解析或从节点种子推导本地身份。
 * @param {{ nodeHash?: string, nodePubKey?: string, secretKey?: Uint8Array } | undefined} localIdentity 可选的预置身份
 * @returns {{ nodeHash: string, nodePubKey: string, secretKey: Uint8Array }} 规范化后的本地身份
 */
function resolveLocalIdentity(localIdentity) {
	if (localIdentity?.nodeHash && localIdentity?.nodePubKey && localIdentity?.secretKey)
		return {
			nodeHash: normalizeHex64(localIdentity.nodeHash),
			nodePubKey: normalizeHex64(localIdentity.nodePubKey),
			secretKey: localIdentity.secretKey,
		}
	const secretKey = Buffer.from(ensureNodeSeed(), 'hex')
	const { publicKey } = keyPairFromSeed(secretKey)
	return {
		nodeHash: getNodeHash(),
		nodePubKey: Buffer.from(publicKey).toString('hex'),
		secretKey,
	}
}

/**
 * 创建带 backlog 的缓冲信令会话。
 * @param {(message: unknown) => Promise<void>} sendRemote 远端发送回调
 * @returns {{ send: (message: unknown) => Promise<void>, onRemote: (handler: (message: unknown) => void) => () => void, deliver: (message: unknown) => void, clear: () => void }} 信令会话
 */
function createBufferedSignalSession(sendRemote) {
	/** @type {Set<(message: unknown) => void>} */
	const handlers = new Set()
	/** @type {unknown[]} */
	const backlog = []
	return {
		/**
		 * 发送信令消息到远端。
		 * @param {unknown} message 信令消息
		 * @returns {Promise<void>}
		 */
		async send(message) {
			await sendRemote(message)
		},
		/**
		 * 注册远端信令 handler（含 backlog 回放）。
		 * @param {(message: unknown) => void} handler 入站回调
		 * @returns {() => void} 取消订阅函数
		 */
		onRemote(handler) {
			handlers.add(handler)
			for (const pending of backlog.splice(0))
				handler(pending)
			return () => handlers.delete(handler)
		},
		/**
		 * 投递信令消息；无 handler 时入 backlog。
		 * @param {unknown} message 信令消息
		 * @returns {void}
		 */
		deliver(message) {
			if (!handlers.size) {
				backlog.push(message)
				return
			}
			for (const handler of handlers)
				handler(message)
		},
		/**
		 * 清空 backlog 与 handler。
		 * @returns {void}
		 */
		clear() {
			backlog.length = 0
			handlers.clear()
		},
	}
}

/**
 * 向 Map<key, Set<listener>> 订阅并返回取消函数。
 * @param {Map<string, Set<Function>>} buckets 监听器桶
 * @param {string} key 桶键
 * @param {Function} listener 监听器
 * @returns {() => void} 取消订阅函数
 */
function subscribeBucket(buckets, key, listener) {
	if (!buckets.has(key)) buckets.set(key, new Set())
	buckets.get(key).add(listener)
	return () => {
		const set = buckets.get(key)
		if (!set) return
		set.delete(listener)
		if (!set.size) buckets.delete(key)
	}
}

/**
 * 创建 P2P 链路注册表（discovery、信令、直连与 overlay relay）。
 * @param {object} [options] 选项
 * @param {{ nodeHash?: string, nodePubKey?: string, secretKey?: Uint8Array }} [options.localIdentity] 本地身份
 * @param {RTCConfiguration['iceServers']} [options.iceServers] ICE 服务器列表（包内 webrtc provider 使用）
 * @param {number} [options.maxActive] 最大并发活跃链路数
 * @param {boolean} [options.autoRegisterDiscoveryProviders] 是否自动注册 discovery provider
 * @param {boolean} [options.autoRegisterLinkProviders] 是否自动注册内置 link provider
 * @returns {object} link registry 接口（对上层即 fount 网络：ensure/send/subscribe，无传输类型）
 */
export function createLinkRegistry(options = {}) {
	const localIdentity = resolveLocalIdentity(options.localIdentity)
	const iceServers = options.iceServers?.length ? options.iceServers : DEFAULT_ICE_SERVERS
	const maxActive = Math.max(4, Number(options.maxActive) || 32)
	const autoRegisterDiscoveryProviders = options.autoRegisterDiscoveryProviders !== false
	const autoRegisterLinkProviders = options.autoRegisterLinkProviders !== false
	const selfTopic = nodeRendezvousTopic(localIdentity.nodeHash)
	/** @type {Map<string, object>} */
	const links = new Map()
	/** @type {Map<string, Promise<object | null>>} 按 nodeHash 去重的主动外拨 */
	const inflights = new Map()
	/** @type {Map<string, ReturnType<typeof createBufferedSignalSession>>} 按 connId 索引的信令会话（每条 PC 一个方向） */
	const signalSessions = new Map()
	/** @type {Map<string, Set<string>>} */
	const scopeInterests = new Map()
	/** @type {Map<string, Set<Function>>} */
	const scopeListeners = new Map()
	/** @type {Map<string, Function>} */
	const scopeAuthorizers = new Map()
	/** @type {Set<(nodeHash: string, link: unknown) => void>} */
	const linkUpListeners = new Set()
	/** @type {Set<(nodeHash: string, reason: string) => void>} */
	const linkDownListeners = new Set()
	const recentAdverts = createLruMap(1024)
	let runtimeStarted = false
	let stopAdvert = null
	let stopSignalListener = null
	/** @type {Array<() => void>} */
	const stopLinkListeners = []
	let overlayRouter = null
	/** @type {ReturnType<typeof createLanTcpLinkProvider> | null} 本 registry 持有的 lan_tcp 实例 */
	let ownedLanTcp = null
	/** @type {ReturnType<typeof createBleGattLinkProvider> | null} 本 registry 持有的 ble_gatt 实例 */
	let ownedBleGatt = null

	/**
	 * 自动注册默认 LinkProvider（lan_tcp / webrtc / ble_gatt）。
	 * lan_tcp / ble_gatt 每 registry 一个实例（避免 ensureListening 覆盖他人的 localIdentity）；
	 * webrtc 按 id 单例注册。拨号时再经 isAvailable / canReach 跳过。
	 * @returns {Promise<void>}
	 */
	async function ensureLinkProviders() {
		if (!autoRegisterLinkProviders) return
		if (!ownedLanTcp) {
			ownedLanTcp = createLanTcpLinkProvider()
			registerLinkProvider(ownedLanTcp)
		}
		if (!ownedBleGatt) {
			ownedBleGatt = createBleGattLinkProvider()
			registerLinkProvider(ownedBleGatt)
		}
		const ids = new Set(listLinkProviders().map(provider => provider.id))
		if (!ids.has('webrtc'))
			registerLinkProvider(createWebRtcLinkProvider())
	}

	/**
	 * 本 registry 的 LAN TCP 监听端口。
	 * @returns {number | null} listen 端口；未 listen 为 null
	 */
	function resolveLanTcpPort() {
		const endpoint = typeof ownedLanTcp?.localEndpoint === 'function' ? ownedLanTcp.localEndpoint() : null
		return normalizeTcpPort(endpoint?.port)
	}

	/**
	 * 构造带本机身份与（若已 listen）tcpPort 的签名 advert。
	 * node / group / scoped 广播共用，保证 LAN hint 可从任意 topic 学到。
	 * @param {string} topic 广播主题
	 * @returns {Promise<{ nodeHash: string, nodePubKey: string, ts: number, sig: string, tcpPort?: number }>} 签名 advert
	 */
	async function buildLocalAdvert(topic) {
		const tcpPort = resolveLanTcpPort()
		return await buildSignedAdvert(topic, Date.now(), {
			...localIdentity,
			...tcpPort != null ? { tcpPort } : {},
		})
	}

	/**
	 * 启动 discovery + link provider listening。
	 * 先 ensureListening（拿到 lan_tcp 端口），再广播带 tcpPort 的 advert。
	 * @returns {Promise<void>}
	 */
	async function ensureDiscoveryRuntime() {
		if (runtimeStarted) return
		runtimeStarted = true
		await ensureLinkProviders()
		if (autoRegisterDiscoveryProviders) {
			const providerIds = new Set(listDiscoveryProviders().map(provider => provider.id))
			if (!providerIds.has('mdns'))
				registerDiscoveryProvider(createMdnsDiscoveryProvider())
			if (!providerIds.has('bt')) {
				const bt = await import('../discovery/bt/index.mjs').catch(() => null)
				if (await bt?.canUseBluetoothDiscovery?.())
					registerDiscoveryProvider(bt.createBluetoothDiscoveryProvider())
			}
			if (!providerIds.has('nostr'))
				// 测试通过 initNode({ signaling: { relayOverride } }) 注入共享 loopback relay；生产则回落到用户 relay + 默认公网 relay。
				// 新 discovery 栈也必须尊重这层 runtime override，否则 live 双节点测试会各打各的公网 relay。
				registerDiscoveryProvider(createNostrDiscoveryProvider({
					relayUrls: getSignalingRuntimeConfig().relayOverride
						?? mergeSignalingRelayUrls(getNodeTransportSettings().relayUrls),
				}))
		}
		// 只对本 registry 持有的 lan_tcp / ble_gatt 调用 ensureListening。
		// 切勿遍历其它 registry 的 lan_tcp:* / ble_gatt:* ——会覆盖其 localIdentity/onInbound。
		/** @type {import('../link/providers/index.mjs').LinkProvider[]} */
		const listenProviders = []
		if (ownedLanTcp) listenProviders.push(ownedLanTcp)
		// 无适配器时 isAvailable 应在 import native 前返回 false；勿无条件 ensureListening（会 loadBleno）。
		if (ownedBleGatt && await Promise.resolve(ownedBleGatt.isAvailable()))
			listenProviders.push(ownedBleGatt)
		for (const provider of await listAvailableLinkProviders()) {
			const id = String(provider.id)
			if (id.startsWith('lan_tcp') || id.startsWith('ble_gatt')) continue
			if (typeof provider.ensureListening === 'function')
				listenProviders.push(provider)
		}
		for (const provider of listenProviders) 
			try {
				const stop = await provider.ensureListening({
					localIdentity,
					/**
					 * @param {object} link 入站链路
					 * @returns {void}
					 */
					onInbound(link) {
						void (async () => {
							try {
								await link.ready
								const remote = normalizeHex64(link.nodeHash)
								if (!remote) {
									await link.close('inbound-no-nodehash')
									return
								}
								await registerResolvedLink(remote, link)
							}
							catch { /* ignore failed inbound */ }
						})()
					},
				})
				if (typeof stop === 'function') stopLinkListeners.push(stop)
			}
			catch { /* provider listen unavailable — normal degrade */ }
		
		if (listDiscoveryProviders().length) {
			stopSignalListener = await listenSignals(selfTopic, bytes => {
				void handleIncomingSignal(bytes).catch(() => { })
			})
			stopAdvert = await advertiseTopic(selfTopic, encryptSignalPacket(selfTopic, {
				type: 'advert',
				body: await buildLocalAdvert(selfTopic),
			}))
		}
	}

	/**
	 * 为单条 PC 创建按 connId 标记的信令会话。出站信令都带上 connId，
	 * 使同一对节点的两个方向（各自一条 PC）在信令层互不串扰。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @param {string} connId 连接标识
	 * @returns {ReturnType<typeof createBufferedSignalSession>} 信令会话
	 */
	function createConnSession(remoteNodeHash, connId) {
		const normalized = normalizeHex64(remoteNodeHash)
		const topic = nodeRendezvousTopic(normalized)
		return createBufferedSignalSession(async message => {
			await sendSignal(topic, normalized, encryptSignalPacket(topic, {
				type: 'signal',
				from: localIdentity.nodeHash,
				connId,
				body: message,
			}))
		})
	}

	/**
	 * 判断信令 body 是否为发起方 offer（据此决定入站是否新建应答 PC）。
	 * @param {unknown} body 信令 body
	 * @returns {boolean} 是 offer 则 true
	 */
	function isOfferSignalBody(body) {
		return !!body && typeof body === 'object'
			&& body.type === 'description'
			&& body.description?.type === 'offer'
	}

	/**
	 * 择链：更高 level 优先；同 level 时保留由较小 nodeHash 发起的那条（glare 两端一致）。
	 * @param {object} link 链路实例
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @param {object | null} [against] 现有规范链
	 * @returns {boolean} 本条链应保留则 true
	 */
	function linkIsPreferred(link, remoteNodeHash, against = null) {
		const level = Number(link.level) || 0
		const againstLevel = Number(against?.level) || 0
		if (against && level !== againstLevel) return level > againstLevel
		const cmp = compareHex64Asc(localIdentity.nodeHash, remoteNodeHash)
		return link.initiator ? cmp < 0 : cmp > 0
	}

	/**
	 * 为链路绑定 envelope 派发与 down 回调。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @param {object} link 链路实例
	 * @returns {void}
	 */
	function wireLink(remoteNodeHash, link) {
		link.onEnvelope((envelope, senderNodeHash) => {
			void dispatchEnvelope(senderNodeHash, envelope, link).catch(() => { })
		})
		link.onDown(reason => {
			// 只有关闭的是当前规范链路才对外报 linkDown；双 PC 并存期关掉的败者不应误发 peer-leave。
			const wasCanonical = links.get(remoteNodeHash) === link
			if (!wasCanonical) return
			links.delete(remoteNodeHash)
			for (const listener of linkDownListeners)
				try { listener(remoteNodeHash, reason) } catch { /* ignore */ }
		})
	}

	/**
	 * 注册已建立的链路：level 优先，同 level 再按 initiator/nodeHash glare 规则择一。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @param {object} candidate 候选链路
	 * @returns {Promise<void>}
	 */
	async function registerResolvedLink(remoteNodeHash, candidate) {
		const normalized = normalizeHex64(remoteNodeHash)
		const existing = links.get(normalized)
		if (existing && existing !== candidate && !linkIsPreferred(candidate, normalized, existing)) {
			await candidate.close(Number(candidate.level) !== Number(existing.level) ? 'provider-loser' : 'glare-loser')
			return
		}
		links.set(normalized, candidate)
		wireLink(normalized, candidate)
		if (existing && existing !== candidate)
			await existing.close(Number(candidate.level) !== Number(existing.level) ? 'provider-replaced' : 'glare-replaced')
		for (const listener of linkUpListeners)
			try { listener(normalized, candidate) } catch { /* ignore */ }
	}

	/**
	 * 找已注册的 offer/answer provider（按 level 降序的第一个）。
	 * @returns {import('../link/providers/index.mjs').LinkProvider | null} 命中的 provider
	 */
	function findOfferAnswerProvider() {
		return listLinkProviders().find(provider => provider.caps?.needsOfferAnswer) ?? null
	}

	/**
	 * Offer/answer provider：为一条 connId 会话建链并走 glare 择一。
	 * @param {{ provider: import('../link/providers/index.mjs').LinkProvider, remoteNodeHash: string, connId: string, session: ReturnType<typeof createBufferedSignalSession>, initiator: boolean }} options 建链参数
	 * @returns {Promise<object | null>} 当前规范链；失败 null
	 */
	async function buildConnLink({ provider, remoteNodeHash, connId, session, initiator }) {
		try {
			if (initiator) await trimToBudget()
			const link = await (initiator ? provider.dial : provider.accept)({
				nodeHash: remoteNodeHash,
				signal: session,
				iceServers,
				localIdentity,
			})
			if (!link) {
				signalSessions.delete(connId)
				return null
			}
			link.onDown(() => signalSessions.delete(connId))
			await link.ready
			await registerResolvedLink(remoteNodeHash, link)
			return links.get(remoteNodeHash) ?? null
		}
		catch {
			signalSessions.delete(connId)
			return null
		}
	}

	/**
	 * 处理入站加密信令并可能发起被动建链。
	 * @param {Uint8Array} bytes 加密信令字节
	 * @returns {Promise<void>}
	 */
	async function handleIncomingSignal(bytes) {
		const packet = decryptSignalPacket(selfTopic, bytes)
		if (!packet || packet.type !== 'signal') return
		const remoteNodeHash = normalizeHex64(packet.from)
		const connId = String(packet.connId || '')
		if (!remoteNodeHash || remoteNodeHash === localIdentity.nodeHash || !connId) return
		// 仅 needsOfferAnswer 走双 PC glare；其它 provider 不吃 SDP 信令。
		let session = signalSessions.get(connId)
		if (!session) {
			// 只有全新的 offer 才开一条独立应答 PC；answer/ice 若无对应 connId 会话则是迟到/无效帧，丢弃。
			// 应答 PC 按 connId 独立创建，不受按 nodeHash 去重的 inflight 阻挡——这是支持双向同时建链的关键。
			if (!isOfferSignalBody(packet.body)) return
			const provider = findOfferAnswerProvider()
			if (!provider) return
			session = createConnSession(remoteNodeHash, connId)
			signalSessions.set(connId, session)
			void buildConnLink({ provider, remoteNodeHash, connId, session, initiator: false })
		}
		session.deliver(packet.body)
	}

	/**
	 * 计算节点在 scope 兴趣中的权重（用于 eviction）。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @returns {number} 权重值
	 */
	function scopeWeight(remoteNodeHash) {
		let weight = 0
		for (const hashes of scopeInterests.values())
			if (hashes.has(remoteNodeHash)) weight++
		return weight
	}

	/**
	 * 超出 maxActive 时驱逐权重最低的链路。
	 * @returns {Promise<void>}
	 */
	async function trimToBudget() {
		if (links.size < maxActive) return
		const candidates = [...links.entries()]
			.sort((left, right) => scopeWeight(left[0]) - scopeWeight(right[0]) || compareHex64Asc(left[0], right[0]))
		const victim = candidates[0]
		if (victim) await victim[1].close('budget-evict')
	}

	/**
	 * 经 offer/answer provider 拨号（discovery signal + glare）。
	 * @param {import('../link/providers/index.mjs').LinkProvider} provider 链路提供者
	 * @param {string} remoteNodeHash 远端 64 hex
	 * @returns {Promise<object | null>} 当前规范链；失败 null
	 */
	async function dialOfferAnswer(provider, remoteNodeHash) {
		const connId = randomBytes(16).toString('hex')
		const session = createConnSession(remoteNodeHash, connId)
		signalSessions.set(connId, session)
		return await buildConnLink({ provider, remoteNodeHash, connId, session, initiator: true })
	}

	/**
	 * 经非 offer/answer provider 拨号。
	 * @param {import('../link/providers/index.mjs').LinkProvider} provider 链路提供者
	 * @param {string} remoteNodeHash 远端 64 hex
	 * @returns {Promise<object | null>} 当前规范链；失败 null
	 */
	async function dialProvider(provider, remoteNodeHash) {
		await trimToBudget()
		const link = await provider.dial({
			nodeHash: remoteNodeHash,
			localIdentity,
			iceServers,
		})
		if (!link) return null
		await link.ready
		await registerResolvedLink(remoteNodeHash, link)
		return links.get(remoteNodeHash) ?? null
	}

	/**
	 * 按 level 降序尝试各 LinkProvider，不可用/不可达/失败则回落。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @returns {Promise<object | null>} 链路实例；失败时 null
	 */
	async function ensureDirectLinkToNode(remoteNodeHash) {
		await ensureDiscoveryRuntime()
		const normalized = normalizeHex64(remoteNodeHash)
		if (!normalized || normalized === localIdentity.nodeHash) return null
		if (links.has(normalized)) return links.get(normalized)
		if (inflights.has(normalized)) return await inflights.get(normalized)
		const task = (async () => {
			const providers = await listAvailableLinkProviders()
			for (const provider of providers) 
				try {
					if (typeof provider.canReach === 'function') {
						const reachable = await Promise.resolve(provider.canReach({ nodeHash: normalized }))
						if (!reachable) continue
					}
					if (provider.caps?.needsOfferAnswer) {
						// soft-fail 返回 null（不 throw）；必须 continue 才能落到更低 level。
						const link = await dialOfferAnswer(provider, normalized)
						if (link) return link
						continue
					}
					const link = await dialProvider(provider, normalized)
					if (link) return link
				}
				catch { /* dial failed — try next provider */ }
			
			return null
		})().finally(() => inflights.delete(normalized))
		inflights.set(normalized, task)
		return await task
	}

	/**
	 * 经已有直连发送 envelope。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @param {{ scope: string, action: string, payload: unknown }} envelope 信封
	 * @returns {Promise<boolean>} 是否发送成功
	 */
	async function sendDirectToNodeLink(remoteNodeHash, envelope) {
		const normalized = normalizeHex64(remoteNodeHash)
		if (!normalized) return false
		const link = links.get(normalized)
		if (!link) return false
		try {
			return await link.send(envelope)
		}
		catch {
			return false
		}
	}

	/**
	 * 懒创建 overlay 路由器。
	 * @returns {ReturnType<typeof createOverlayRouter>} overlay 路由器
	 */
	function getOverlayRouter() {
		if (overlayRouter) return overlayRouter
		overlayRouter = createOverlayRouter({
			localIdentity,
			sendToNodeLink: sendDirectToNodeLink,
			/**
			 * 列出当前所有活跃链路。
			 * @returns {Array<{ nodeHash: string, link: object }>} 链路列表
			 */
			listLinks() {
				return [...links.entries()].map(([nodeHash, link]) => ({ nodeHash, link }))
			},
			subscribeScope,
		})
		overlayRouter.onRelay((body, meta) => {
			void dispatchEnvelope(meta.path[0], body, null).catch(() => { })
		})
		return overlayRouter
	}

	/**
	 * 经 overlay 多跳 relay envelope 到无直连的节点。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @param {{ scope: string, action: string, payload: unknown }} envelope 信封
	 * @returns {Promise<boolean>} 是否 relay 成功
	 */
	async function relayEnvelopeToNode(remoteNodeHash, envelope) {
		if (!links.size || envelope?.scope === 'overlay') return false
		try {
			const path = await getOverlayRouter().discoverRoute(remoteNodeHash)
			await getOverlayRouter().relay(path, envelope)
			return true
		}
		catch {
			return false
		}
	}

	/**
	 * 确保到远端节点的链路（直连或被动应答）。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @returns {Promise<object | null>} 链路实例
	 */
	async function ensureLinkToNode(remoteNodeHash) {
		return await ensureDirectLinkToNode(remoteNodeHash)
	}

	/**
	 * 发送 envelope：优先直连，失败则 overlay relay。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @param {{ scope: string, action: string, payload: unknown }} envelope 信封
	 * @returns {Promise<boolean>} 是否发送成功
	 */
	async function sendToNodeLink(remoteNodeHash, envelope) {
		return await sendDirectToNodeLink(remoteNodeHash, envelope)
			|| await relayEnvelopeToNode(remoteNodeHash, envelope)
	}

	/**
	 * 将入站 envelope 派发到 scope 监听器（经 authorizer 校验）。
	 * @param {string} senderNodeHash 发送方节点 64 hex
	 * @param {{ scope: string, action: string, payload: unknown }} envelope 信封
	 * @param {object} link 来源链路
	 * @returns {Promise<void>}
	 */
	async function dispatchEnvelope(senderNodeHash, envelope, link) {
		const scope = String(envelope?.scope || '')
		for (const [prefix, authorizer] of scopeAuthorizers.entries())
			if (scope.startsWith(prefix)) {
				const allowed = await Promise.resolve(authorizer(scope, senderNodeHash, envelope, link))
				if (!allowed) return
			}
		for (const [prefix, listeners] of scopeListeners.entries())
			if (scope.startsWith(prefix))
				for (const listener of listeners)
					await Promise.resolve(listener(senderNodeHash, envelope, link))
	}

	/**
	 * 订阅指定 scope 前缀的 envelope。
	 * @param {string} prefix scope 前缀
	 * @param {(senderNodeHash: string, envelope: { scope: string, action: string, payload: unknown }, link: object) => void | Promise<void>} listener 监听器
	 * @returns {() => void} 取消订阅函数
	 */
	function subscribeScope(prefix, listener) {
		return subscribeBucket(scopeListeners, String(prefix), listener)
	}

	/**
	 * 注册 scope 前缀的 authorizer（入站校验）。
	 * @param {string} prefix scope 前缀
	 * @param {(scope: string, senderNodeHash: string, envelope: object, link: object) => boolean | Promise<boolean>} authorizer 校验函数
	 * @returns {() => void} 取消注册函数
	 */
	function registerScopeAuthorizer(prefix, authorizer) {
		scopeAuthorizers.set(String(prefix), authorizer)
		return () => scopeAuthorizers.delete(String(prefix))
	}

	return {
		localIdentity,
		buildLocalAdvert,
		lanTcpPort: resolveLanTcpPort,
		ensureRuntime: ensureDiscoveryRuntime,
		ensureLinkToNode,
		/**
		 * 获取到指定节点的活跃链路。
		 * @param {string} nodeHash 节点 64 hex
		 * @returns {object | null} 链路实例；不存在时 null
		 */
		getLink(nodeHash) {
			return links.get(normalizeHex64(nodeHash)) || null
		},
		/**
		 * 列出所有活跃链路。
		 * @returns {Array<{ nodeHash: string, link: object }>} 链路列表
		 */
		listLinks() {
			return [...links.entries()].map(([nodeHash, link]) => ({ nodeHash, link }))
		},
		/**
		 * 关闭到指定节点的链路。
		 * @param {string} nodeHash 节点 64 hex
		 * @param {string} [reason='manual-close'] 关闭原因
		 * @returns {Promise<void>}
		 */
		async closeLink(nodeHash, reason = 'manual-close') {
			const normalized = normalizeHex64(nodeHash)
			const link = links.get(normalized)
			if (!link) return
			await link.close(reason)
		},
		sendToNodeLink,
		/**
		 * 订阅链路建立事件。
		 * @param {(nodeHash: string, link: unknown) => void} listener 回调
		 * @returns {() => void} 取消订阅函数
		 */
		onLinkUp(listener) {
			linkUpListeners.add(listener)
			return () => linkUpListeners.delete(listener)
		},
		/**
		 * 订阅链路断开事件。
		 * @param {(nodeHash: string, reason: string) => void} listener 回调
		 * @returns {() => void} 取消订阅函数
		 */
		onLinkDown(listener) {
			linkDownListeners.add(listener)
			return () => linkDownListeners.delete(listener)
		},
		/**
		 * 注册 scope 兴趣成员（影响 eviction 权重）。
		 * @param {string} scope scope 名称
		 * @param {string[]} nodeHashes 成员 nodeHash 列表
		 * @returns {void}
		 */
		registerScopeInterest(scope, nodeHashes) {
			scopeInterests.set(String(scope), new Set((Array.isArray(nodeHashes) ? nodeHashes : []).map(normalizeHex64).filter(Boolean)))
		},
		/**
		 * 释放 scope 兴趣。
		 * @param {string} scope scope 名称
		 * @returns {void}
		 */
		releaseScopeInterest(scope) {
			scopeInterests.delete(String(scope))
		},
		registerScopeAuthorizer,
		subscribeScope,
		/**
		 * 订阅指定节点的 advert 广播。
		 * @param {string} nodeHash 目标节点 64 hex
		 * @param {(verifiedNodeHash: string, body: object) => void | Promise<void>} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消订阅函数
		 */
		async subscribeNodeAdvert(nodeHash, onAdvert) {
			const topic = nodeRendezvousTopic(nodeHash)
			return await subscribeTopic(topic, async (bytes, meta) => {
				const packet = decryptSignalPacket(topic, bytes)
				if (packet?.type !== 'advert') return
				const verifiedNodeHash = await verifySignedAdvert(topic, packet.body)
				if (!verifiedNodeHash) return
				noteAdvertPeerHints(verifiedNodeHash, packet.body, meta)
				recentAdverts.touch(verifiedNodeHash, Date.now())
				await Promise.resolve(onAdvert(verifiedNodeHash, packet.body))
			})
		},
		recentAdverts,
		relayEnvelopeToNode,
		/**
		 * 关闭 registry：停止 discovery、overlay 并断开所有链路。
		 * @returns {Promise<void>}
		 */
		async shutdown() {
			stopAdvert?.()
			stopSignalListener?.()
			for (const stop of stopLinkListeners.splice(0))
				try { stop() } catch { /* ignore */ }
			overlayRouter?.close()
			overlayRouter = null
			for (const link of links.values())
				await link.close('registry-shutdown')
			links.clear()
			inflights.clear()
			for (const session of signalSessions.values()) session.clear()
			signalSessions.clear()
			if (ownedLanTcp) {
				unregisterLinkProvider(ownedLanTcp.id)
				ownedLanTcp = null
			}
			if (ownedBleGatt) {
				unregisterLinkProvider(ownedBleGatt.id)
				ownedBleGatt = null
			}
			runtimeStarted = false
		},
	}
}

let defaultRegistry = null

/**
 * 获取进程级默认 link registry 单例。
 * @returns {ReturnType<typeof createLinkRegistry>} 默认 registry
 */
export function getLinkRegistry() {
	if (!defaultRegistry) defaultRegistry = createLinkRegistry()
	return defaultRegistry
}

/**
 * 默认 registry 的 ensureLinkToNode 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['ensureLinkToNode']>} 链路实例
 */
export const ensureLinkToNode = (...args) => getLinkRegistry().ensureLinkToNode(...args)
/**
 * 默认 registry 的 getLink 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['getLink']>} 链路实例
 */
export const getLink = (...args) => getLinkRegistry().getLink(...args)
/**
 * 默认 registry 的 listLinks 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['listLinks']>} 链路列表
 */
export const listLinks = (...args) => getLinkRegistry().listLinks(...args)
/**
 * 默认 registry 的 closeLink 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['closeLink']>} 关闭完成
 */
export const closeLink = (...args) => getLinkRegistry().closeLink(...args)
/**
 * 默认 registry 的 sendToNodeLink 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['sendToNodeLink']>} 是否成功
 */
export const sendToNodeLink = (...args) => getLinkRegistry().sendToNodeLink(...args)
/**
 * 默认 registry 的 relayEnvelopeToNode 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['relayEnvelopeToNode']>} 是否成功
 */
export const relayEnvelopeToNode = (...args) => getLinkRegistry().relayEnvelopeToNode(...args)
/**
 * 默认 registry 的 onLinkUp 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['onLinkUp']>} 取消订阅函数
 */
export const onLinkUp = (...args) => getLinkRegistry().onLinkUp(...args)
/**
 * 默认 registry 的 onLinkDown 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['onLinkDown']>} 取消订阅函数
 */
export const onLinkDown = (...args) => getLinkRegistry().onLinkDown(...args)
/**
 * 默认 registry 的 registerScopeInterest 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['registerScopeInterest']>} 无返回值
 */
export const registerScopeInterest = (...args) => getLinkRegistry().registerScopeInterest(...args)
/**
 * 默认 registry 的 releaseScopeInterest 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['releaseScopeInterest']>} 无返回值
 */
export const releaseScopeInterest = (...args) => getLinkRegistry().releaseScopeInterest(...args)
/**
 * 默认 registry 的 registerScopeAuthorizer 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['registerScopeAuthorizer']>} 取消注册函数
 */
export const registerScopeAuthorizer = (...args) => getLinkRegistry().registerScopeAuthorizer(...args)
/**
 * 默认 registry 的 subscribeScope 代理。
 * @param {...any} args 转发参数
 * @returns {ReturnType<ReturnType<typeof createLinkRegistry>['subscribeScope']>} 取消订阅函数
 */
export const subscribeScope = (...args) => getLinkRegistry().subscribeScope(...args)
