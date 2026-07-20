import { Buffer } from 'node:buffer'

import { compareHex64Asc, normalizeHex64 } from '../core/hexIds.mjs'
import { keyPairFromSeed } from '../crypto/crypto.mjs'
import { noteAdvertPeerHints } from '../discovery/advert_peer_hints.mjs'
import { subscribeTopic } from '../discovery/index.mjs'
import { verifySignedAdvert } from '../link/handshake.mjs'
import { listLinkProviders } from '../link/providers/index.mjs'
import { ensureNodeSeed, getNodeHash } from '../node/identity.mjs'
import { createOverlayRouter } from '../overlay/index.mjs'
import { createLruMap } from '../utils/lru.mjs'

import { DEFAULT_ICE_SERVERS } from './ice_servers.mjs'
import { createOfferAnswerDial } from './offer_answer.mjs'
import { createRuntimeBootstrap } from './runtime_bootstrap.mjs'
import {
	decryptSignalPacket,
	nodeRendezvousTopic,
} from './signal_crypto.mjs'

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
 * @param {boolean} [options.autoRegisterDiscoveryProviders] 是否自动注册 discovery provider
 * @param {boolean} [options.autoRegisterLinkProviders] 是否自动注册内置 link provider
 * @returns {object} link registry 接口（对上层即 fount 网络：ensure/send/subscribe，无传输类型）
 */
export function createLinkRegistry(options = {}) {
	const localIdentity = resolveLocalIdentity(options.localIdentity)
	const iceServers = options.iceServers?.length ? options.iceServers : DEFAULT_ICE_SERVERS
	const maxActive = Math.max(4, Number(options.maxActive) || 32)
	const selfTopic = nodeRendezvousTopic(localIdentity.nodeHash)
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
		selfTopic,
		autoRegisterDiscoveryProviders: options.autoRegisterDiscoveryProviders !== false,
		autoRegisterLinkProviders: options.autoRegisterLinkProviders !== false,
		onInboundLink,
		handleIncomingSignal: bytes => handleIncomingSignal(bytes),
	})

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

	;({ handleIncomingSignal, dialOfferAnswer } = createOfferAnswerDial({
		localIdentity,
		iceServers,
		selfTopic,
		signalSessions,
		registerResolvedLink,
		trimToBudget,
		/**
		 * 读取当前规范链。
		 * @param {string} remoteNodeHash 远端节点 64 hex
		 * @returns {object | null | undefined} 规范链实例
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
			const providers = listLinkProviders()
			for (const provider of providers)
				try {
					if (typeof provider.canReach === 'function') {
						const reachable = await Promise.resolve(provider.canReach({ nodeHash: normalized }))
						if (!reachable) continue
					}
					if (typeof provider.isAvailable === 'function') {
						const available = await Promise.resolve(provider.isAvailable())
						if (!available) continue
					}
					if (provider.caps?.needsOfferAnswer) {
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
	 * @param {Function} listener 监听器
	 * @returns {() => void} 取消订阅函数
	 */
	function subscribeScope(prefix, listener) {
		return subscribeBucket(scopeListeners, String(prefix), listener)
	}

	/**
	 * 注册 scope 前缀的 authorizer（入站校验）。
	 * @param {string} prefix scope 前缀
	 * @param {Function} authorizer 校验函数
	 * @returns {() => void} 取消注册函数
	 */
	function registerScopeAuthorizer(prefix, authorizer) {
		scopeAuthorizers.set(String(prefix), authorizer)
		return () => scopeAuthorizers.delete(String(prefix))
	}

	return {
		localIdentity,
		buildLocalAdvert: bootstrap.buildLocalAdvert,
		lanTcpPort: bootstrap.lanTcpPort,
		whenListening: bootstrap.whenListening,
		ensureRuntime: bootstrap.ensureRuntime,
		ensureLinkToNode: ensureDirectLinkToNode,
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

/**
 * 获取进程级默认 link registry 单例。
 * @returns {ReturnType<typeof createLinkRegistry>} 默认 registry
 */
export function getLinkRegistry() {
	return defaultRegistry ||= createLinkRegistry()
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
