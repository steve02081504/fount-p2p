import { noteAdvertPeerHints } from '../discovery/advert_peer_hints.mjs'
import { verifySignedAdvert } from '../link/handshake.mjs'

import { decryptSignalPacket } from './signal_crypto.mjs'

/**
 * 解密验签 advert，写入 peer hints；失败返回 null。
 * @param {string} topic rendezvous 主题
 * @param {Uint8Array} bytes 加密 advert 载荷
 * @param {object} [meta] 发现元数据（如 relayUrl）
 * @returns {Promise<{ verifiedNodeHash: string, body: object } | null>} 验签后的节点与 body
 */
export async function ingestSignedAdvert(topic, bytes, meta) {
	const packet = decryptSignalPacket(topic, bytes)
	if (packet?.type !== 'advert' || !packet.body) return null
	const verifiedNodeHash = await verifySignedAdvert(topic, packet.body)
	if (!verifiedNodeHash) return null
	noteAdvertPeerHints(verifiedNodeHash, packet.body, meta)
	return { verifiedNodeHash, body: packet.body }
}
