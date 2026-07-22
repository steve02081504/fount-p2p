import { normalizeTcpPort } from '../core/tcp_port.mjs'

import { noteBtPeerHint } from './bt/peer_hints.mjs'
import { normalizeLanHosts } from './lan_interfaces.mjs'
import { noteLanPeerHint } from './lan_peer_hints.mjs'

/**
 * 从已验证的 discovery advert + provider meta 写入 LAN/BT peer hints。
 * 任意 discovery 路径（node / group / scoped）收到 advert 时都应调用。
 * meta.address（观测地址）优先于 body.lanHosts（自报地址）。
 * @param {string} verifiedNodeHash 验签通过的 nodeHash
 * @param {{ tcpPort?: unknown, lanHosts?: unknown } | null | undefined} body advert body
 * @param {{ address?: unknown, peripheralId?: unknown } | null | undefined} meta discovery provider meta
 * @returns {void}
 */
export function noteAdvertPeerHints(verifiedNodeHash, body, meta) {
	if (meta?.peripheralId)
		noteBtPeerHint(verifiedNodeHash, meta.peripheralId)
	const tcpPort = normalizeTcpPort(body?.tcpPort)
	if (tcpPort == null) return
	// lanHosts 先写（差→优，unshift 后优在前），再写观测 address，使 address 最优先
	for (const host of normalizeLanHosts(body?.lanHosts).toReversed())
		noteLanPeerHint(verifiedNodeHash, { host, port: tcpPort })
	const address = String(meta?.address || '').trim()
	if (address)
		noteLanPeerHint(verifiedNodeHash, { host: address, port: tcpPort })
}
