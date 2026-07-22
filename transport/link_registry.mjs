import { Buffer } from 'node:buffer'

import { compareHex64Asc, normalizeHex64 } from '../core/hexIds.mjs'
import { keyPairFromSeed } from '../crypto/crypto.mjs'
import { watchVerifiedNodeAdvert, setDiscoveryLinkDialer, prepareConnectToNode } from '../discovery/index.mjs'
import { listLinkProviders } from '../link/providers/index.mjs'
import { ensureNodeSeed, getNodeHash } from '../node/identity.mjs'
import { nodeDebug, shortHash } from '../node/log.mjs'
import { loadPeerPoolView } from '../node/network.mjs'
import { createOverlayRouter } from '../overlay/index.mjs'
import { emitSafe } from '../utils/emit_safe.mjs'
import { createLruMap } from '../utils/lru.mjs'

import { applyAdvertPeerHints } from './advert_ingest.mjs'
import { DEFAULT_ICE_SERVERS } from './ice_servers.mjs'
import { createMeshKeepalive } from './mesh_keepalive.mjs'
import { createOfferAnswerDial } from './offer_answer.mjs'
import { pickMeshEvictionVictim } from './peer_pool.mjs'
import { createRuntimeBootstrap } from './runtime_bootstrap.mjs'

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
 * @param {boolean} [options.meshKeepalive=true] 是否启用 mesh 保活（N/K 扫描拨号）
 * @param {boolean} [options.autoRegisterDiscoveryProviders] 是否自动注册 discovery provider
 * @param {boolean} [options.autoRegisterLinkProviders] 是否自动注册内置 link provider
 * @returns {object} link registry 接口（对上层即 fount 网络：ensure/send/subscribe，无传输类型）
 */
export function createLinkRegistry(options = {}) {
	const localIdentity = resolveLocalIdentity(options.localIdentity)
	let iceServers = options.iceServers?.length ? options.iceServers : DEFAULT_ICE_SERVERS
	let maxActive = Math.max(4, Number(options.maxActive) || 32)
	const savedMaxActive = maxActive
	const meshKeepaliveEnabled = options.meshKeepalive !== false
	/** @type {((nodeHash: string) => number) | null} */
	let priorityWeightFunction = null
	/** @type {Set<string>} */
	let exploreLinkHashes = new Set()
	/** @type {ReturnType<typeof createMeshKeepalive> | null} */
	let meshKeepalive = null
	/** @type {Map<string, object>} */
	const links = new Map()
	/** @type {Map<string, Promise<object | null>>} */
	const inflights = new Map()
	/** @type {Map<string, ReturnType<typeof import('./offer_answer.mjs').createBufferedSignalSession>>} */
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
	let overlayRouter = null

	/** @type {(bytes: Uint8Array) => Promise<void>} */
	let handleIncomingSignal = async () => { }
	/** @type {(provider: import('../link/providers/index.mjs').LinkProvider, remoteNodeHash: string) => Promise<object | null>} */
	let dialOfferAnswer = async () => null

	/**
	 * 择链：更高 level 优先；同 level 时保留由较小 nodeHash 发起的那条（glare 两端一致）。
	 * @param {object} link 候选链路
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @param {object | null} [against] 当前规范链
	 * @returns {boolean} 候选链应保留为规范链时 true
	 */
	function linkIsPreferred(link, remoteNodeHash, against = null) {
		const level = link.level || 0
		const againstLevel = against?.level || 0
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
			const wasCanonical = links.get(remoteNodeHash) === link
			if (!wasCanonical) return
			links.delete(remoteNodeHash)
			emitSafe(linkDownListeners, remoteNodeHash, reason)
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
			await candidate.close(candidate.level !== existing.level ? 'provider-loser' : 'glare-loser')
			return
		}
		links.set(normalized, candidate)
		wireLink(normalized, candidate)
		if (existing && existing !== candidate)
			await existing.close(candidate.level !== existing.level ? 'provider-replaced' : 'glare-replaced')
		emitSafe(linkUpListeners, normalized, candidate)
	}

	/**
	 * 入站链路共用 onInbound（lan_tcp / 后台 ble 等）。
	 * @param {object} link 入站链路
	 * @returns {void}
	 */
	function onInboundLink(link) {
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
	}

	const bootstrap = createRuntimeBootstrap({
		localIdentity,
		autoRegisterDiscoveryProviders: options.autoRegisterDiscoveryProviders !== false,
		autoRegisterLinkProviders: options.autoRegisterLinkProviders !== false,
		onInboundLink,
		/**
		 * @param {Uint8Array} bytes 入站加密信令
		 * @returns {Promise<void>}
		 */
		handleIncomingSignal: bytes => handleIncomingSignal(bytes),
	})

	/**
	 * 计算节点在 scope 兴趣中的权重（用于 eviction）。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @returns {number} 权重值
	 */
	function scopeWeight(remoteNodeHash) {
		let weight = priorityWeightFunction?.(remoteNodeHash) ?? 0
		for (const hashes of scopeInterests.values())
			if (hashes.has(remoteNodeHash)) weight++
		return weight
	}

	/**
	 * 超出 maxActive 时驱逐：探索链优先于熟人/scope 权重。
	 * @returns {Promise<void>}
	 */
	async function trimToBudget() {
		if (links.size < maxActive) return
		const peers = loadPeerPoolView()
		const victimHash = pickMeshEvictionVictim(
			[...links.keys()],
			exploreLinkHashes,
			peers.trustedPeers,
			scopeWeight,
		)
		const victimLink = victimHash ? links.get(victimHash) : null
		if (victimLink) await victimLink.close('budget-evict')
	}

	; ({ handleIncomingSignal, dialOfferAnswer } = createOfferAnswerDial({
		localIdentity,
		/**
		 * @returns {RTCConfiguration['iceServers']} 当前 ICE 服务器列表
		 */
		get iceServers() { return iceServers },
		signalSessions,
		registerResolvedLink,
		trimToBudget,
		/**
		 * @param {string} remoteNodeHash 远端 nodeHash
		 * @returns {object | null} 已有规范链路
		 */
		getCanonicalLink: remoteNodeHash => links.get(normalizeHex64(remoteNodeHash)),
	}))

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
		await bootstrap.ensureRuntime()
		await bootstrap.whenSignalListening()
		const normalized = normalizeHex64(remoteNodeHash)
		if (!normalized || normalized === localIdentity.nodeHash) return null
		if (links.has(normalized)) return links.get(normalized)
		if (inflights.has(normalized)) return await inflights.get(normalized)
		const task = (async () => {
			nodeDebug('p2p:dial start', { peer: shortHash(normalized) })
			await prepareConnectToNode(normalized)
			const providers = listLinkProviders()
			for (const provider of providers)
				try {
					if (typeof provider.canReach === 'function') {
						const reachable = await Promise.resolve(provider.canReach({ nodeHash: normalized }))
						if (!reachable) {
							nodeDebug('p2p:dial skip', { peer: shortHash(normalized), provider: provider.id, reason: 'canReach=false' })
							continue
						}
					}
					if (typeof provider.isAvailable === 'function') {
						const available = await Promise.resolve(provider.isAvailable())
						if (!available) {
							nodeDebug('p2p:dial skip', { peer: shortHash(normalized), provider: provider.id, reason: 'isAvailable=false' })
							continue
						}
					}
					nodeDebug('p2p:dial try', { peer: shortHash(normalized), provider: provider.id })
					if (provider.caps?.needsOfferAnswer) {
						const link = await dialOfferAnswer(provider, normalized)
						if (link) {
							nodeDebug('p2p:dial ok', { peer: shortHash(normalized), provider: provider.id })
							return link
						}
						nodeDebug('p2p:dial miss', { peer: shortHash(normalized), provider: provider.id })
						continue
					}
					const link = await dialProvider(provider, normalized)
					if (link) {
						nodeDebug('p2p:dial ok', { peer: shortHash(normalized), provider: provider.id })
						return link
					}
					nodeDebug('p2p:dial miss', { peer: shortHash(normalized), provider: provider.id })
				}
				catch (error) {
					nodeDebug('p2p:dial fail', {
						peer: shortHash(normalized),
						provider: provider.id,
						err: String(error?.message || error),
					})
				}

			nodeDebug('p2p:dial exhausted', { peer: shortHash(normalized) })
			return null
		})().finally(() => inflights.delete(normalized))
		inflights.set(normalized, task)
		return await task
	}

	meshKeepalive = createMeshKeepalive({
		registry: {
			localIdentity,
			/**
			 * @returns {Array<{ nodeHash: string, link: object }>} 当前链路列表
			 */
			listLinks: () => [...links.entries()].map(([nodeHash, link]) => ({ nodeHash, link })),
			/**
			 * @param {string} nodeHash 目标 nodeHash
			 * @returns {object | null} 已有链路或 null
			 */
			getLink: nodeHash => links.get(normalizeHex64(nodeHash)) || null,
			ensureLinkToNode: ensureDirectLinkToNode,
			/**
			 * @param {(nodeHash: string) => void} listener link up 回调
			 * @returns {() => void} 取消订阅
			 */
			onLinkUp: listener => {
				linkUpListeners.add(listener)
				return () => linkUpListeners.delete(listener)
			},
			/**
			 * @param {(nodeHash: string, reason: string) => void} listener link down 回调
			 * @returns {() => void} 取消订阅
			 */
			onLinkDown: listener => {
				linkDownListeners.add(listener)
				return () => linkDownListeners.delete(listener)
			},
		},
		enabled: meshKeepaliveEnabled,
	})
	exploreLinkHashes = meshKeepalive.exploreLinkHashes
	setDiscoveryLinkDialer(ensureDirectLinkToNode)

	/**
	 *
	 */
	const ensureRuntimeWithMesh = async () => {
		await bootstrap.ensureRuntime()
		meshKeepalive?.start()
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
			/** @returns {Array<{ nodeHash: string, link: object }>} 当前活跃链路列表 */
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
	 * @returns {import('../overlay/index.mjs').OverlayRouter} overlay 路由器单例
	 */
	function ensureOverlayRouter() {
		return getOverlayRouter()
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
			const overlay = getOverlayRouter()
			const path = await overlay.discoverRoute(remoteNodeHash)
			await overlay.relay(path, envelope)
			return true
		}
		catch {
			return false
		}
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
	 * 同步结果直接返回；thenable 才 await（避免每条 envelope 造 microtask）。
	 * @param {unknown} value 可能为 Promise 的返回值
	 * @returns {Promise<unknown>} 已 resolve 的值
	 */
	async function maybeAwait(value) {
		if (value != null && typeof /** @type {{ then?: unknown }} */ value.then === 'function')
			return await value
		return value
	}

	/**
	 * 将入站 envelope 派发到 scope 监听器（经 authorizer 校验）。
	 * @param {string} senderNodeHash 发送方节点 64 hex
	 * @param {{ scope: string, action: string, payload: unknown }} envelope 信封
	 * @param {object} link 来源链路
	 * @returns {Promise<void>}
	 */
	async function dispatchEnvelope(senderNodeHash, envelope, link) {
		const scope = envelope.scope || ''
		for (const [prefix, authorizer] of scopeAuthorizers.entries())
			if (scope.startsWith(prefix)) {
				const allowed = await maybeAwait(authorizer(scope, senderNodeHash, envelope, link))
				if (!allowed) return
			}
		for (const [prefix, listeners] of scopeListeners.entries())
			if (scope.startsWith(prefix))
				for (const listener of listeners)
					await maybeAwait(listener(senderNodeHash, envelope, link))
	}

	/**
	 * 订阅指定 scope 前缀的 envelope。
	 * @param {string} prefix scope 前缀
	 * @param {Function} listener 监听器
	 * @returns {() => void} 取消订阅函数
	 */
	function subscribeScope(prefix, listener) {
		return subscribeBucket(scopeListeners, prefix, listener)
	}

	/**
	 * 注册 scope 前缀的 authorizer（入站校验）。
	 * @param {string} prefix scope 前缀
	 * @param {Function} authorizer 校验函数
	 * @returns {() => void} 取消注册函数
	 */
	function registerScopeAuthorizer(prefix, authorizer) {
		scopeAuthorizers.set(prefix, authorizer)
		return () => scopeAuthorizers.delete(prefix)
	}

	return {
		localIdentity,
		buildLocalAdvert: bootstrap.buildLocalAdvert,
		lanTcpPort: bootstrap.lanTcpPort,
		whenListening: bootstrap.whenListening,
		ensureRuntime: ensureRuntimeWithMesh,
		reloadDiscoveryRelays: bootstrap.reloadDiscoveryRelays,
		ensureOverlayRouter,
		getOverlayRouter,
		ensureLinkToNode: ensureDirectLinkToNode,
		/**
		 * 设置最大并发活跃链路数。
		 * @param {number} value 最大并发活跃链路数
		 * @returns {Promise<void>}
		 */
		async setMaxActive(value) {
			maxActive = Math.max(4, Math.min(128, Math.floor(Number(value) || savedMaxActive)))
			await trimToBudget()
		},
		/**
		 * @returns {number} 当前 maxActive
		 */
		getMaxActive() {
			return maxActive
		},
		/**
		 * 设置 ICE 服务器列表。
		 * @param {RTCConfiguration['iceServers']} servers ICE 列表
		 * @returns {void}
		 */
		setIceServers(servers) {
			iceServers = servers?.length ? servers : DEFAULT_ICE_SERVERS
		},
		/**
		 * @returns {RTCConfiguration['iceServers']} 当前 ICE 服务器列表
		 */
		getIceServers() {
			return iceServers
		},
		/**
		 * infra/trim：额外优先级权重；null 清除。
		 * @param {((nodeHash: string) => number) | null} weightFunction 额外 trim 权重；null 清除
		 * @returns {void}
		 */
		setPriorityWeightFunction(weightFunction) {
			priorityWeightFunction = typeof weightFunction === 'function' ? weightFunction : null
		},
		/**
		 * @param {string} nodeHash - 节点 64-hex hash
		 * @returns {number} 额外路由 trim 权重
		 */
		getPriorityWeight(nodeHash) {
			return priorityWeightFunction?.(nodeHash) ?? 0
		},
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
			scopeInterests.set(scope, new Set((nodeHashes || []).map(normalizeHex64).filter(Boolean)))
		},
		/**
		 * 释放 scope 兴趣。
		 * @param {string} scope scope 名称
		 * @returns {void}
		 */
		releaseScopeInterest(scope) {
			scopeInterests.delete(scope)
		},
		registerScopeAuthorizer,
		subscribeScope,
		/**
		 * 监听指定节点的 advert（per-hash，无 topic）。
		 * @param {string} nodeHash 目标节点 64 hex
		 * @param {(verifiedNodeHash: string, body: object) => void | Promise<void>} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消函数
		 */
		async watchNodeAdvert(nodeHash, onAdvert) {
			const hash = normalizeHex64(nodeHash)
			return await watchVerifiedNodeAdvert(hash, async (verifiedNodeHash, body, meta) => {
				applyAdvertPeerHints(verifiedNodeHash, body, meta)
				recentAdverts.touch(verifiedNodeHash, Date.now())
				await Promise.resolve(onAdvert(verifiedNodeHash, body))
			})
		},
		recentAdverts,
		relayEnvelopeToNode,
		/**
		 * 关闭 registry：停止 discovery、overlay 并断开所有链路。
		 * @returns {Promise<void>}
		 */
		async shutdown() {
			await meshKeepalive?.stop()
			setDiscoveryLinkDialer(null)
			await bootstrap.shutdown()
			overlayRouter?.close()
			overlayRouter = null
			for (const link of links.values())
				await link.close('registry-shutdown')
			links.clear()
			inflights.clear()
			for (const session of signalSessions.values()) session.clear()
			signalSessions.clear()
		},
	}
}

let defaultRegistry = null
/** @type {object | null} */
let pendingRegistryOptions = null

/**
 * 在首次 getLinkRegistry 前配置默认 registry 选项。
 * @param {object} options createLinkRegistry 选项
 * @returns {void}
 */
export function configureLinkRegistry(options = {}) {
	if (defaultRegistry) throw new Error('p2p: configureLinkRegistry must run before getLinkRegistry')
	pendingRegistryOptions = { ...pendingRegistryOptions, ...options }
}

/**
 * @returns {void}
 */
export function resetLinkRegistryForTests() {
	defaultRegistry = null
	pendingRegistryOptions = null
}

/**
 * 默认 registry 尚未创建时暂存的 scope authorizer 条目。
 * 注册阶段不应触发 createLinkRegistry / resolveLocalIdentity；绑定在 getLinkRegistry flush 时完成。
 * @type {Array<{ prefix: string, authorizer: Function, unregister: (() => void) | null }>}
 */
const pendingScopeAuthorizers = []

/**
 * 获取进程级默认 link registry 单例。
 * @returns {ReturnType<typeof createLinkRegistry>} 默认 registry
 */
export function getLinkRegistry() {
	if (defaultRegistry) return defaultRegistry
	defaultRegistry = createLinkRegistry(pendingRegistryOptions || {})
	pendingRegistryOptions = null
	for (const entry of pendingScopeAuthorizers)
		entry.unregister = defaultRegistry.registerScopeAuthorizer(entry.prefix, entry.authorizer)
	pendingScopeAuthorizers.length = 0
	return defaultRegistry
}

/**
 * 默认 registry 方法代理。
 * @param {string} name registry 方法名
 * @returns {(...methodArguments: unknown[]) => unknown} 绑定到 getLinkRegistry()[name] 的函数
 */
const bindRegistryMethod = name => (...methodArguments) => getLinkRegistry()[name](...methodArguments)

/** 确保 overlay 路由器已创建。 @type {(...methodArguments: unknown[]) => unknown} */
export const ensureOverlayRouter = bindRegistryMethod('ensureOverlayRouter')
/** 热重载 discovery relay 配置。 @type {(...methodArguments: unknown[]) => unknown} */
export const reloadDiscoveryRelays = bindRegistryMethod('reloadDiscoveryRelays')
/** 确保到 nodeHash 的活跃链路。 @type {(...methodArguments: unknown[]) => unknown} */
export const ensureLinkToNode = bindRegistryMethod('ensureLinkToNode')
/** @type {(...methodArguments: unknown[]) => unknown} */
export const getLink = bindRegistryMethod('getLink')
/** @type {(...methodArguments: unknown[]) => unknown} */
export const listLinks = bindRegistryMethod('listLinks')
/** @type {(...methodArguments: unknown[]) => unknown} */
export const closeLink = bindRegistryMethod('closeLink')
/** 经活跃链路向节点发送 envelope。 @type {(...methodArguments: unknown[]) => unknown} */
export const sendToNodeLink = bindRegistryMethod('sendToNodeLink')
/** @type {(...methodArguments: unknown[]) => unknown} */
export const relayEnvelopeToNode = bindRegistryMethod('relayEnvelopeToNode')
/** @type {(...methodArguments: unknown[]) => unknown} */
export const onLinkUp = bindRegistryMethod('onLinkUp')
/** @type {(...methodArguments: unknown[]) => unknown} */
export const onLinkDown = bindRegistryMethod('onLinkDown')
/** @type {(...methodArguments: unknown[]) => unknown} */
export const registerScopeInterest = bindRegistryMethod('registerScopeInterest')
/** @type {(...methodArguments: unknown[]) => unknown} */
export const releaseScopeInterest = bindRegistryMethod('releaseScopeInterest')
/** @type {(...methodArguments: unknown[]) => unknown} */
export const subscribeScope = bindRegistryMethod('subscribeScope')

/**
 * 注册默认 registry 的 scope authorizer。
 * 不急切创建 registry（不必 resolveLocalIdentity）；首次 getLinkRegistry 时 flush。
 * @param {string} prefix scope 前缀
 * @param {Function} authorizer 校验函数
 * @returns {() => void} 取消注册函数
 */
export function registerScopeAuthorizer(prefix, authorizer) {
	if (defaultRegistry) return defaultRegistry.registerScopeAuthorizer(prefix, authorizer)

	const entry = { prefix, authorizer, unregister: null }
	pendingScopeAuthorizers.push(entry)
	return () => {
		const index = pendingScopeAuthorizers.indexOf(entry)
		if (index !== -1) pendingScopeAuthorizers.splice(index, 1)
		entry.unregister?.()
	}
}
