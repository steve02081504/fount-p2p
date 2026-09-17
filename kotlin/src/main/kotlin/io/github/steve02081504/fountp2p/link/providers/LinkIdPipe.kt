package io.github.steve02081504.fountp2p.link.providers

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.toBytes
import io.github.steve02081504.fountp2p.link.LinkPipe
import io.github.steve02081504.fountp2p.link.LinkPipeOptions

/**
 * 构造 link-open control JSON。
 * @param linkId 链路 id（64 hex）
 * @param fromNodeHash 本端 nodeHash
 * @return JSON 文本
 */
@JvmOverloads
fun buildLinkOpen(linkId: String, fromNodeHash: String = ""): String =
	Json.stringify(linkedMapOf<String, Any?>("type" to "link-open", "linkId" to linkId, "from" to (fromNodeHash.ifEmpty { "" }))) ?: "null"

/**
 * 解析 link-open；非法返回 null。
 * @param raw 原始 control（String 或 ByteArray）
 * @return 解析结果
 */
fun parseLinkOpen(raw: Any?): Map<String, Any?>? {
	val parsed = try {
		Json.parse(if (raw is String) raw else String(toBytes(raw), Charsets.UTF_8))
	}
	catch (_: Exception) {
		null
	}
	val obj = parsed as? Map<*, *> ?: return null
	if (obj["type"] != "link-open" || obj["linkId"] == null || obj["linkId"] == io.github.steve02081504.fountp2p.core.JsonUndefined) return null
	return linkedMapOf("linkId" to obj["linkId"].toString(), "from" to isHex64(obj["from"]))
}

/**
 * 以固定 linkId 作为 hello/auth binding 的 pipe。
 * @param options pipe 配置（须含 linkId）
 * @return link pipe
 */
fun createLinkIdBoundPipe(options: LinkPipeOptions, linkId: String?): LinkPipe {
	if (linkId.isNullOrEmpty()) throw IllegalArgumentException("p2p: ${options.providerId.ifEmpty { "link" }} linkId required")
	return LinkPipe(options.withBindings({ linkId }, { linkId }))
}
