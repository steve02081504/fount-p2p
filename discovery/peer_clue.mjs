import { normalizeHex64 } from '../core/hexIds.mjs'

/** @type {((nodeHash: string) => void) | null} */
let peerClueListener = null

/**
 * 由 link registry 注入：peer 首次可见时清 dial 冷却。
 * @param {((nodeHash: string) => void) | null} listener 回调
 * @returns {void}
 */
export function setDiscoveryPeerClueListener(listener) {
	peerClueListener = listener
}

/**
 * discovery accept 路径：peer 首次进入可见池时通知 registry。
 * @param {string} nodeHash 对端
 * @returns {void}
 */
export function noteDiscoveryPeerClue(nodeHash) {
	const hash = normalizeHex64(nodeHash)
	if (hash) peerClueListener?.(hash)
}
