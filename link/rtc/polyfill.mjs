import process from 'node:process'

import { getRtcPolyfillCacheEpoch, getSignalingRuntimeConfig } from '../../node/instance.mjs'
import { nodeDebug } from '../../node/log.mjs'

import { wrapRtcPeerConnectionForIceLocalHostname } from './ice_local_hostname.mjs'
import { bridgePeerConnection } from './w3c_bridge.mjs'

/** @type {boolean} */
let exitCleanupHooked = false

/** @type {Promise<LoadedRtcPolyfill> | null} */
let cachedDefaultPolyfill = null

/** @type {number} 与 cachedDefaultPolyfill 绑定的策略世代 */
let cachedDefaultPolyfillEpoch = -1

/**
 * @typedef {{
 *   RTCPeerConnection: typeof RTCPeerConnection,
 *   RTCIceCandidate: typeof RTCIceCandidate,
 *   backend: string,
 *   forcesTrickleIce: boolean,
 * }} LoadedRtcPolyfill
 * @typedef {{
 *   id: string,
 *   forcesTrickleIce?: boolean,
 *   load: () => Promise<{ RTCPeerConnection: typeof RTCPeerConnection, RTCIceCandidate: typeof RTCIceCandidate }>,
 * }} RtcBackend
 */

/**
 * 清除默认后端加载缓存（iceLocalHostnamePolicy 变更后调用）。
 * @returns {void}
 */
export function clearNodeRtcPolyfillCache() {
	cachedDefaultPolyfill = null
	cachedDefaultPolyfillEpoch = -1
}

/**
 * 注册进程退出时销毁 libdatachannel 原生资源（首次成功加载后挂一次）。
 * libdatachannel 的原生线程在 pc.close() 后仍需时间回收；进程退出时若原生资源未同步销毁，
 * Windows 上会触发堆损坏（退出码 0xC0000374）。
 * @returns {Promise<void>}
 */
async function ensureNodeDatachannelExitCleanup() {
	if (exitCleanupHooked) return
	exitCleanupHooked = true
	const { cleanup = undefined } = await import('node-datachannel').catch(() => ({}))
	process.on('exit', () => {
		try { cleanup?.() } catch { /* already torn down */ }
	})
}

/**
 * @returns {Promise<{ RTCPeerConnection: typeof RTCPeerConnection, RTCIceCandidate: typeof RTCIceCandidate }>} node-datachannel 构造器
 */
async function loadNodeDatachannelBackend() {
	const mod = await import('node-datachannel/polyfill')
	await ensureNodeDatachannelExitCleanup()
	return {
		RTCPeerConnection: mod.RTCPeerConnection,
		RTCIceCandidate: mod.RTCIceCandidate,
	}
}

/**
 * 纯 JS WebRTC DataChannel（Termux / 无 native prebuild 时的 fallback）。
 * @returns {Promise<{ RTCPeerConnection: typeof RTCPeerConnection, RTCIceCandidate: typeof RTCIceCandidate }>} node-rtc-connection 构造器
 */
async function loadNodeRtcConnectionBackend() {
	const module = await import('node-rtc-connection')
	return {
		RTCPeerConnection: /** @type {typeof RTCPeerConnection} */ bridgePeerConnection(module.RTCPeerConnection),
		RTCIceCandidate: module.RTCIceCandidate,
	}
}

/** @type {RtcBackend} */
const PURE_JS_BACKEND = {
	id: 'node-rtc-connection',
	forcesTrickleIce: true,
	load: loadNodeRtcConnectionBackend,
}

/**
 * @returns {RtcBackend[]} 默认后端顺序：优先 native，失败再纯 JS
 */
function defaultRtcBackends() {
	/** @type {RtcBackend[]} */
	const backends = []
	// Android/Termux：无官方 prebuild，且 Bionic 不能跑 linux-arm64 glibc 包；直接走纯 JS。
	if (process.platform !== 'android')
		backends.push({ id: 'node-datachannel', load: loadNodeDatachannelBackend })
	backends.push(PURE_JS_BACKEND)
	return backends
}

/**
 * @param {{ backends?: RtcBackend[] }} options 后端列表
 * @returns {Promise<LoadedRtcPolyfill>} 首个可用后端的 polyfill
 */
async function loadNodeRtcPolyfillUncached(options) {
	const backends = options.backends?.length
		? [...options.backends, PURE_JS_BACKEND]
		: defaultRtcBackends()
	/** @type {unknown} */
	let lastError = null
	for (const backend of backends)
		try {
			const mod = await backend.load()
			const { iceLocalHostnamePolicy } = getSignalingRuntimeConfig()
			return {
				RTCPeerConnection: wrapRtcPeerConnectionForIceLocalHostname(
					mod.RTCPeerConnection,
					mod.RTCIceCandidate,
					iceLocalHostnamePolicy,
				),
				RTCIceCandidate: mod.RTCIceCandidate,
				backend: backend.id,
				forcesTrickleIce: backend.forcesTrickleIce === true,
			}
		}
		catch (error) {
			lastError = error
			nodeDebug('p2p:webrtc backend unavailable', {
				backend: backend.id,
				err: String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 240),
			})
		}

	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'no rtc backend'))
}

/**
 * 加载 RTC polyfill（node-datachannel 优先，失败则 node-rtc-connection），并按配置包装 RTCPeerConnection。
 * 默认后端路径会缓存首次成功结果；注入 backends 时不走缓存。
 * @param {{ backends?: RtcBackend[] }} [options] 可注入后端列表（测试用）
 * @returns {Promise<LoadedRtcPolyfill>} RTC 构造器
 */
export async function loadNodeRtcPolyfill(options = {}) {
	if (options.backends?.length)
		return loadNodeRtcPolyfillUncached(options)
	const epoch = getRtcPolyfillCacheEpoch()
	if (!cachedDefaultPolyfill || cachedDefaultPolyfillEpoch !== epoch) {
		cachedDefaultPolyfill = null
		cachedDefaultPolyfillEpoch = epoch
		const pending = loadNodeRtcPolyfillUncached(options).catch(error => {
			if (cachedDefaultPolyfill === pending) {
				cachedDefaultPolyfill = null
				cachedDefaultPolyfillEpoch = -1
			}
			throw error
		})
		cachedDefaultPolyfill = pending
	}
	return cachedDefaultPolyfill
}
