import { normalizeHex64 } from '../core/hexIds.mjs'
import { nodeDebug, shortHash } from '../node/log.mjs'

import { ingestGroupAdvert, ingestNodeAdvert } from './adverts.mjs'
import { decryptSignalPacket, encryptSignalPacket, nodeRendezvousKey } from './internal/signal_crypto.mjs'

/** @typedef {{ id: string, priority: number, caps?: { canDiscover?: boolean, canSignal?: boolean, canRelay?: boolean }, listVisibleNodeHashes?: (options?: { limit?: number, roomSecret?: string }) => Promise<string[]>, connectToNode?: (nodeHash: string, options?: object) => Promise<boolean | null>, startPresence?: (getBeacon: () => Promise<object | null>) => Promise<() => void>, startGroupPresence?: (roomSecret: string, getBeacon: () => Promise<object | null>) => Promise<() => void>, sendNodeSignal?: (toNodeHash: string, bytes: Uint8Array) => Promise<boolean | void>, listenNodeSignals?: (localNodeHash: string, onSignal: (bytes: Uint8Array) => void) => Promise<() => void>, watchNodeAdvert?: (nodeHash: string, onAdvert: (bytes: Uint8Array, meta: object) => void) => Promise<() => void>, watchGroupAdverts?: (roomSecret: string, onAdvert: (bytes: Uint8Array, meta: object) => void) => Promise<() => void>, noteVisibleNode?: (nodeHash: string, options?: { roomSecret?: string }) => void, dispose?: () => void }} DiscoveryProvider */

/** @type {Map<string, DiscoveryProvider>} */
const providers = new Map()

/** @type {((nodeHash: string) => Promise<object | null>) | null} */
let linkDialer = null

/**
 * 由 link registry 注入：discovery.connectToNode 经此建链（dialer 内负责 prepare）。
 * @param {((nodeHash: string) => Promise<object | null>) | null} dialer 拨号函数
 * @returns {void}
 */
export function setDiscoveryLinkDialer(dialer) {
	linkDialer = dialer
}

/**
 * @param {DiscoveryProvider} provider 发现提供者
 * @returns {() => void} 注销函数
 */
export function registerDiscoveryProvider(provider) {
	if (!provider?.id) throw new Error('p2p: discovery provider requires id')
	providers.set(String(provider.id), provider)
	return () => unregisterDiscoveryProvider(provider.id)
}

/**
 * @param {string} id 提供者 id
 * @returns {void}
 */
export function unregisterDiscoveryProvider(id) {
	const provider = providers.get(String(id))
	providers.delete(String(id))
	try { provider?.dispose?.() } catch { /* ignore */ }
}

/** @returns {void} */
export function clearDiscoveryProviders() {
	const list = [...providers.values()]
	providers.clear()
	for (const provider of list)
		try { provider.dispose?.() } catch { /* ignore */ }
}

/** @returns {DiscoveryProvider[]} 按 priority 升序排列的已注册提供者 */
export function listDiscoveryProviders() {
	return [...providers.values()].sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0))
}

/**
 * @param {string} id 提供者 id
 * @returns {DiscoveryProvider | undefined} 对应 id 的提供者，未注册为 undefined
 */
export function getDiscoveryProvider(id) {
	return providers.get(String(id))
}

/**
 * @param {string} method provider 方法名
 * @returns {DiscoveryProvider[]} 实现了指定方法的提供者列表
 */
function providersWith(method) {
	return listDiscoveryProviders().filter(provider => typeof provider[method] === 'function')
}

/**
 * @param {Array<(() => void) | null | undefined>} cleanups 清理函数
 * @returns {() => void} 调用时依次执行各 cleanup
 */
function composeCleanups(cleanups) {
	return () => {
		for (const stop of cleanups)
			if (typeof stop === 'function') try { stop() } catch { /* ignore */ }
	}
}

/**
 * 对各实现了 method 的 provider 并行调用，合并 cleanup。
 * @param {string} method provider 方法名
 * @param {unknown[]} methodArguments 参数
 * @param {{ errorLabel?: string, requireAny?: boolean }} [options] requireAny 默认 true
 * @returns {Promise<() => void>} 合并各 provider 返回的 cleanup
 */
async function fanInProviderMethod(method, methodArguments, options = {}) {
	const requireAny = options.requireAny !== false
	const capable = providersWith(method)
	if (requireAny && !capable.length) throw new Error(options.errorLabel || `p2p: ${method} unavailable`)
	const cleanups = await Promise.all(capable.map(async provider => {
		try {
			return await provider[method](...methodArguments)
		}
		catch {
			return null
		}
	}))
	if (requireAny && !cleanups.some(stop => typeof stop === 'function'))
		throw new Error(options.errorLabel || `p2p: ${method} unavailable`)
	return composeCleanups(cleanups)
}

/**
 * 合并各 provider 可见 nodeHash（带 roomSecret 时各介质只返回本群池；不懂群的介质应返回 []）。
 * @param {{ limit?: number, roomSecret?: string }} [options] 扫描选项
 * @returns {Promise<string[]>} 去重后的 nodeHash 列表
 */
export async function listVisibleNodeHashes(options = {}) {
	const limit = Math.max(1, Number(options.limit) || 64)
	const seen = new Set()
	/** @type {Record<string, string[]>} */
	const byProvider = {}
	for (const provider of listDiscoveryProviders()) {
		if (typeof provider.listVisibleNodeHashes !== 'function') continue
		try {
			const hashes = await provider.listVisibleNodeHashes(options)
			byProvider[provider.id] = hashes.map(hash => shortHash(hash))
			for (const hash of hashes) {
				if (hash) seen.add(hash)
				if (seen.size >= limit) break
			}
			if (seen.size >= limit) break
		}
		catch (error) {
			nodeDebug('p2p:discovery list fail', {
				provider: provider.id,
				err: String(error?.message || error),
			})
		}
	}
	const out = [...seen].slice(0, limit)
	nodeDebug('p2p:discovery visible', {
		total: out.length,
		group: !!options.roomSecret,
		byProvider,
	})
	return out
}

/**
 * 各发现介质准备通往 nodeHash 的路径（hint / 订阅 / 近场），不建链。
 * @param {string} nodeHash 目标 nodeHash
 * @param {object} [options] 额外选项
 * @returns {Promise<void>}
 */
export async function prepareConnectToNode(nodeHash, options = {}) {
	const hash = normalizeHex64(nodeHash)
	for (const provider of listDiscoveryProviders()) {
		if (typeof provider.connectToNode !== 'function') continue
		try { await provider.connectToNode(hash, options) }
		catch { /* prepare next medium */ }
	}
}

/**
 * 经 registry dialer 建链（dialer 内 prepare）；无 dialer 时仅 prepare，返回 false。
 * @param {string} nodeHash 目标 nodeHash
 * @param {object} [options] 无 dialer 时转交 prepare
 * @returns {Promise<boolean>} 是否建链成功
 */
export async function connectToNode(nodeHash, options = {}) {
	const hash = normalizeHex64(nodeHash)
	if (!linkDialer) {
		await prepareConnectToNode(hash, options)
		nodeDebug('p2p:discovery connect skip', { peer: shortHash(hash), reason: 'no-dialer' })
		return false
	}
	try {
		const ok = !!await linkDialer(hash)
		nodeDebug(ok ? 'p2p:discovery connect ok' : 'p2p:discovery connect miss', { peer: shortHash(hash) })
		return ok
	}
	catch (error) {
		nodeDebug('p2p:discovery connect fail', {
			peer: shortHash(hash),
			err: String(error?.message || error),
		})
		return false
	}
}

/**
 * 经各可信令介质发送；任一成功即返回。
 * @param {string} toNodeHash 目标 nodeHash
 * @param {Uint8Array} bytes 载荷
 * @returns {Promise<void>}
 */
export async function sendNodeSignal(toNodeHash, bytes) {
	const capable = providersWith('sendNodeSignal')
	if (!capable.length) throw new Error('p2p: signaling unavailable')
	let lastError = null
	for (const provider of capable)
		try {
			const result = await provider.sendNodeSignal(toNodeHash, bytes)
			if (result !== false) return
		}
		catch (error) {
			lastError = error
		}

	if (lastError) throw lastError
	throw new Error('p2p: signaling unavailable')
}

/**
 * 在各可信令介质上监听；返回统一取消。
 * @param {string} localNodeHash 本机 nodeHash
 * @param {(bytes: Uint8Array) => void} onSignal 回调
 * @returns {Promise<() => void>} 取消函数
 */
export async function listenNodeSignals(localNodeHash, onSignal) {
	return fanInProviderMethod('listenNodeSignals', [localNodeHash, onSignal], {
		errorLabel: 'p2p: signaling unavailable',
	})
}

/**
 * 启动各 provider 的 presence（若支持）。
 * @param {() => Promise<object | null>} getBeacon 本机 beacon
 * @returns {Promise<() => void>} 统一停止函数
 */
export async function startDiscoveryPresence(getBeacon) {
	return fanInProviderMethod('startPresence', [getBeacon], { requireAny: false })
}

/**
 * 监听指定 nodeHash 的 advert（各支持介质 fan-in）。
 * @param {string} nodeHash 目标 nodeHash
 * @param {(bytes: Uint8Array, meta: object) => void} onAdvert 回调
 * @returns {Promise<() => void>} 取消函数
 */
export async function watchNodeAdvert(nodeHash, onAdvert) {
	return fanInProviderMethod('watchNodeAdvert', [nodeHash, onAdvert], {
		errorLabel: 'p2p: node advert watch unavailable',
	})
}

/**
 * 群 advert 监听（各支持介质 fan-in）。
 * @param {string} roomSecret 房间密钥
 * @param {(bytes: Uint8Array, meta: object) => void} onAdvert 回调
 * @returns {Promise<() => void>} 取消群 advert 监听
 */
export async function watchGroupAdverts(roomSecret, onAdvert) {
	return fanInProviderMethod('watchGroupAdverts', [roomSecret, onAdvert], {
		errorLabel: 'p2p: group advert watch unavailable',
	})
}

/**
 * 群 presence 广播（各支持介质 fan-out）。
 * @param {string} roomSecret 房间密钥
 * @param {() => Promise<object | null>} getBeacon advert 工厂
 * @returns {Promise<() => void>} 停止群 presence 广播
 */
export async function startGroupPresence(roomSecret, getBeacon) {
	return fanInProviderMethod('startGroupPresence', [roomSecret, getBeacon], {
		errorLabel: 'p2p: group presence unavailable',
	})
}

/**
 * 向节点发送 JSON 信令包（discovery 内部加解密）。
 * @param {string} toNodeHash 目标 nodeHash
 * @param {unknown} packet JSON 载荷
 * @returns {Promise<void>}
 */
export async function sendNodeSignalPacket(toNodeHash, packet) {
	const hash = normalizeHex64(toNodeHash)
	await sendNodeSignal(hash, encryptSignalPacket(nodeRendezvousKey(hash), packet))
}

/**
 * 解密发往本机的节点信令包。
 * @param {string} localNodeHash 本机 nodeHash
 * @param {Uint8Array} bytes 加密字节
 * @returns {object | null} 解密 JSON
 */
export function decryptNodeSignalPacket(localNodeHash, bytes) {
	return decryptSignalPacket(nodeRendezvousKey(normalizeHex64(localNodeHash)), bytes)
}

/**
 * advert 验签后写入各介质可见池。
 * @param {string} verifiedNodeHash 已验签 nodeHash
 * @param {{ roomSecret?: string }} [options] 带 roomSecret 时写入群池
 * @returns {void}
 */
export function noteVisibleNodeFromAdvert(verifiedNodeHash, options = {}) {
	for (const provider of listDiscoveryProviders())
		provider.noteVisibleNode?.(verifiedNodeHash, options)
}

/**
 * 监听指定 nodeHash 的 advert，验签后回调。
 * @param {string} nodeHash 目标 nodeHash
 * @param {(verifiedNodeHash: string, body: object, meta: object) => void | Promise<void>} onAdvert 回调
 * @returns {Promise<() => void>} 取消函数
 */
export async function watchVerifiedNodeAdvert(nodeHash, onAdvert) {
	return await watchNodeAdvert(nodeHash, async (bytes, meta) => {
		const ingested = await ingestNodeAdvert(nodeHash, bytes, meta)
		if (!ingested) return
		noteVisibleNodeFromAdvert(ingested.verifiedNodeHash)
		await Promise.resolve(onAdvert(ingested.verifiedNodeHash, ingested.body, meta))
	})
}

/**
 * 群 advert 监听 + 验签；写入群可见池。
 * @param {string} roomSecret 房间密钥
 * @param {(verifiedNodeHash: string, body: object, meta: object) => void | Promise<void>} onAdvert 回调
 * @returns {Promise<() => void>} 取消群 advert 验签监听
 */
export async function watchVerifiedGroupAdverts(roomSecret, onAdvert) {
	return await watchGroupAdverts(roomSecret, async (bytes, meta) => {
		const ingested = await ingestGroupAdvert(roomSecret, bytes, meta)
		if (!ingested) return
		noteVisibleNodeFromAdvert(ingested.verifiedNodeHash, { roomSecret })
		await Promise.resolve(onAdvert(ingested.verifiedNodeHash, ingested.body, meta))
	})
}

/** 再导出：scope advert 构建/加密/验签（见 `adverts.mjs`）。 */
export { buildSignedAdvertForScope, encryptAdvertForScope, encryptAdvertPacket, ingestEncryptedAdvert, ingestGroupAdvert, ingestNetworkAdvert, ingestNodeAdvert } from './adverts.mjs'
