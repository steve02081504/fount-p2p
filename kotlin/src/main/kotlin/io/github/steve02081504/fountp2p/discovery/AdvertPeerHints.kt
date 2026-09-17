package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.core.normalizeTcpPort
import io.github.steve02081504.fountp2p.discovery.bt.noteBtPeerHint

/**
 * 从已验证的 discovery advert + provider meta 写入 LAN/BT peer hints。
 *
 * meta.address（观测地址）优先于 body.lanHosts（自报地址）。
 * @param verifiedNodeHash 验签通过的 nodeHash
 * @param body advert body
 * @param meta discovery provider meta
 */
fun noteAdvertPeerHints(verifiedNodeHash: String, body: Map<String, Any?>?, meta: Map<String, Any?>?) {
	val peripheralId = meta?.get("peripheralId")
	if (peripheralId != null && peripheralId !== io.github.steve02081504.fountp2p.core.JsonUndefined)
		noteBtPeerHint(verifiedNodeHash, peripheralId.toString())
	val tcpPort = normalizeTcpPort(body?.get("tcpPort")) ?: return
	for (host in normalizeLanHosts(body?.get("lanHosts")).reversed())
		noteLanPeerHint(verifiedNodeHash, LanEndpoint(host, tcpPort))
	val address = meta?.get("address")?.toString() ?: ""
	if (address.isNotEmpty()) noteLanPeerHint(verifiedNodeHash, LanEndpoint(address, tcpPort))
}
