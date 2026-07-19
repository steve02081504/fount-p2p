import { normalizeTcpPort } from '../core/tcp_port.mjs'

import { noteBtPeerHint } from './bt/peer_hints.mjs'
import { noteLanPeerHint } from './lan_peer_hints.mjs'

/**
 * 从已验证的 discovery advert + provider meta 写入 LAN/BT peer hints。
 * 任意 discovery 路径（node / group / scoped topic）收到 advert 时都应调用。
 * @param {string} verifiedNodeHash 验签通过的 nodeHash
 * @param {{ tcpPort?: unknown } | null | undefined} body advert body
 * @param {{ address?: unknown, peripheralId?: unknown } | null | undefined} meta discovery provider meta
 * @returns {void}
 */
export function noteAdvertPeerHints(verifiedNodeHash, body, meta) {
	if (meta?.peripheralId)
		noteBtPeerHint(verifiedNodeHash, meta.peripheralId)
	const tcpPort = normalizeTcpPort(body?.tcpPort)
	const address = String(meta?.address || '').trim()
	if (tcpPort != null && address)
		noteLanPeerHint(verifiedNodeHash, { host: address, port: tcpPort })
}
