/**
 * 上层（rooms / federation / shell）可见的链路句柄。
 * 不暴露 RTC DataChannel、ICE、GATT 等传输细节；providerId/level/initiator 仅供包内择链。
 * @typedef {{
 *   ready: Promise<void>,
 *   get nodeHash(): string | null,
 *   send: (envelope: { scope: string, action: string, payload: unknown }) => Promise<boolean>,
 *   onEnvelope: (callback: (envelope: { scope: string, action: string, payload: unknown }, remoteNodeHash: string) => void) => () => void,
 *   onDown: (callback: (reason: string) => void) => () => void,
 *   close: (reason?: string) => Promise<void>,
 *   stats: () => object,
 * }} LinkHandle */

/**
 * @typedef {{
 *   id: string,
 *   level: number,
 *   caps?: { needsOfferAnswer?: boolean, needsDiscoverySignal?: boolean },
 *   isAvailable: () => boolean | Promise<boolean>,
 *   canReach?: (remote: { nodeHash: string, hints?: object }) => boolean | Promise<boolean>,
 *   dial: (options: object) => Promise<LinkHandle | null>,
 *   accept?: (options: object) => Promise<LinkHandle | null>,
 *   ensureListening?: (handlers: { onInbound: (link: LinkHandle) => void, localIdentity: object }) => Promise<(() => void) | void> | (() => void) | void,
 *   localEndpoint?: () => { host?: string, port?: number } | null,
 * }} LinkProvider
 */

/** @type {Map<string, LinkProvider>} */
const providers = new Map()

/**
 * 注册 link provider。
 * @param {LinkProvider} provider 链路提供者
 * @returns {() => void} 注销函数
 */
export function registerLinkProvider(provider) {
	if (!provider?.id) throw new Error('p2p: link provider requires id')
	providers.set(String(provider.id), provider)
	return () => unregisterLinkProvider(provider.id)
}

/**
 * 注销 link provider。
 * @param {string} id 提供者 id
 * @returns {void}
 */
export function unregisterLinkProvider(id) {
	providers.delete(String(id))
}

/**
 * 列出已注册的 link provider（按 level 降序）。
 * @returns {LinkProvider[]} 提供者列表
 */
export function listLinkProviders() {
	return [...providers.values()].sort((left, right) => Number(right.level || 0) - Number(left.level || 0))
}

/**
 * 清空全部 link provider（测试用）。
 * @returns {void}
 */
export function clearLinkProviders() {
	providers.clear()
}

/**
 * 列出当前可用的 link provider（isAvailable 失败视为不可用）。
 * @returns {Promise<LinkProvider[]>} 按 level 降序的可用列表
 */
export async function listAvailableLinkProviders() {
	const available = []
	for (const provider of listLinkProviders()) 
		try {
			if (await Promise.resolve(provider.isAvailable()))
				available.push(provider)
		}
		catch {
			/* probe failure → skip */
		}
	
	return available
}

/** 重导出 level 常量。 */
export {
	LINK_LEVEL_LAN_TCP,
	LINK_LEVEL_WEBRTC,
	LINK_LEVEL_BLE_GATT,
} from './levels.mjs'
