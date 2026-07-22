import { buildMergedGraph, pickTopNodes } from './build.mjs'
import { fanoutToTopNodes, sendToNode } from './send.mjs'

/** @type {Map<string, import('./registry.mjs').TrustGraphProvider>} */
const providersByOwner = new Map()

/** 用户级 P2P trust graph（registerTrustGraphProvider 注册） */
export const DEFAULT_TRUST_GRAPH_OWNER = 'default'

/**
 * @param {string} ownerId 注册方（如 chat）
 * @param {import('./registry.mjs').TrustGraphProvider} implementation 信任图实现
 * @returns {void}
 */
export function registerTrustGraphProvider(ownerId, implementation) {
	providersByOwner.set(String(ownerId), implementation)
}

/** @returns {void} */
export function clearTrustGraphProvider() {
	providersByOwner.clear()
}

/**
 * @param {string} [ownerId=DEFAULT_TRUST_GRAPH_OWNER] 注册方 ID
 * @returns {import('./registry.mjs').TrustGraphProvider} 已注册实现
 */
export function requireTrustGraphProvider(ownerId = DEFAULT_TRUST_GRAPH_OWNER) {
	const implementation = providersByOwner.get(String(ownerId))
	if (!implementation)
		throw new Error(`p2p: registerTrustGraphProvider('${ownerId}') must run before trust graph fanout`)
	return implementation
}

/** @returns {import('./registry.mjs').TrustGraphProvider} 默认信任图实现 */
export function createDefaultTrustGraphProvider() {
	return { buildMergedGraph, pickTopNodes, sendToNode, fanoutToTopNodes }
}
