package io.github.steve02081504.fountp2p.files.manifest

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.canonicalStringify
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isSignatureHex128
import io.github.steve02081504.fountp2p.core.parseEntityHash
import io.github.steve02081504.fountp2p.core.assertSafeEvfsLogicalPath
import io.github.steve02081504.fountp2p.core.hashFromPubKeyHex
import io.github.steve02081504.fountp2p.crypto.sign
import io.github.steve02081504.fountp2p.crypto.verify
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.files.jsNumberOr
import io.github.steve02081504.fountp2p.files.jsStringOr
import io.github.steve02081504.fountp2p.files.putFileManifest
import io.github.steve02081504.fountp2p.files.saveFileManifest

/**
 * 实体公开 manifest 签名与验签（等价 `files/manifest/public.mjs`）。
 */

/** 实体公开 manifest 签名域 */
const val ENTITY_PUBLIC_MANIFEST_DOMAIN: String = "fount-entity-public-manifest"

/**
 * @param fields 待签名字段
 * @return 签名消息字节
 */
fun publicManifestSignBytes(fields: Any?): ByteArray {
	val message = listOf(
		ENTITY_PUBLIC_MANIFEST_DOMAIN,
		jsStringOr(Json.at(fields, "ownerEntityHash"), ""),
		assertSafeEvfsLogicalPath(Json.at(fields, "logicalPath") as? String),
		jsNumberOr(Json.at(fields, "publishedAt"), 0.0),
		jsStringOr(Json.at(fields, "contentHash"), ""),
		jsNumberOr(Json.at(fields, "size"), 0.0),
		jsStringOr(Json.at(fields, "mimeType"), ""),
		jsStringOr(Json.at(fields, "name"), ""),
		jsStringOr(Json.at(fields, "ceMode"), ""),
		Json.at(fields, "parts") ?: emptyList<Any?>(),
	)
	return canonicalStringify(message).toByteArray(Charsets.UTF_8)
}

/**
 * @param manifest 清单
 * @param publishedAt 发布时间
 * @param entitySecretKey recovery 私钥种子
 * @param entityPubKeyHex recovery 公钥 hex
 * @return 带 publicSig 的清单
 */
fun attachPublicManifestSig(
	manifest: Map<String, Any?>,
	publishedAt: Double,
	entitySecretKey: ByteArray,
	entityPubKeyHex: String,
): Map<String, Any?> {
	val message = publicManifestSignBytes(
		linkedMapOf(
			"ownerEntityHash" to manifest["ownerEntityHash"],
			"logicalPath" to manifest["logicalPath"],
			"publishedAt" to publishedAt,
			"contentHash" to manifest["contentHash"],
			"size" to manifest["size"],
			"mimeType" to manifest["mimeType"],
			"name" to manifest["name"],
			"ceMode" to manifest["ceMode"],
			"parts" to manifest["parts"],
		),
	)
	val sigHex = bytesToHex(sign(message, entitySecretKey))
	val previousMeta = manifest["meta"] as? Map<*, *>
	val meta = LinkedHashMap<String, Any?>()
	if (previousMeta != null) for ((key, value) in previousMeta) if (key is String) meta[key] = value
	meta["publicSig"] = linkedMapOf(
		"publishedAt" to publishedAt,
		"pubKeyHex" to entityPubKeyHex,
		"sigHex" to sigHex,
	)
	return linkedMapOf<String, Any?>().apply {
		putAll(manifest)
		this["meta"] = meta
	}
}

/**
 * @param input 原始 manifest
 * @return 验签通过的清单；非法为 null
 */
fun verifySignedPublicManifest(input: Any?): Map<String, Any?>? {
	val manifest = normalizeFileManifest(input) ?: return null
	val descriptor = manifest["transferKeyDescriptor"] as? Map<*, *>
	if (descriptor?.get("type") != "public") return null

	val publicSig = Json.at(Json.at(input, "meta"), "publicSig")
	if (publicSig !is Map<*, *>) return null
	val publishedAt = jsNumberOr(publicSig["publishedAt"], 0.0)
	val pubKeyHex = isHex64(publicSig["pubKeyHex"])
	val sigHex = isSignatureHex128(publicSig["sigHex"])
	if (pubKeyHex == null || sigHex == null || publishedAt <= 0) return null

	val parsed = parseEntityHash(manifest["ownerEntityHash"]) ?: return null
	if (hashFromPubKeyHex(pubKeyHex) != parsed.subjectHash) return null

	val message = publicManifestSignBytes(
		linkedMapOf(
			"ownerEntityHash" to manifest["ownerEntityHash"],
			"logicalPath" to manifest["logicalPath"],
			"publishedAt" to publishedAt,
			"contentHash" to manifest["contentHash"],
			"size" to manifest["size"],
			"mimeType" to manifest["mimeType"],
			"name" to manifest["name"],
			"ceMode" to manifest["ceMode"],
			"parts" to manifest["parts"],
		),
	)
	val ok = verify(hexToBytes(sigHex), message, hexToBytes(pubKeyHex))
	if (!ok) return null

	// 签名只覆盖内容字段：入站 meta 一律丢弃，仅保留 publicSig，
	// 防止中继注入 dagParts/groupId 等本地扩展改写读取路径。
	return linkedMapOf<String, Any?>().apply {
		putAll(manifest)
		this["meta"] = linkedMapOf<String, Any?>(
			"publicSig" to linkedMapOf<String, Any?>(
				"publishedAt" to publishedAt,
				"pubKeyHex" to pubKeyHex,
				"sigHex" to sigHex,
			),
		)
	}
}

/**
 * @param localManifest 本地已有清单
 * @param incoming 入站已验签清单
 * @return 是否应以 incoming 覆盖本地缓存
 */
fun shouldPreferIncomingPublicManifest(localManifest: Any?, incoming: Any?): Boolean {
	val incomingAt = jsNumberOr(Json.at(Json.at(Json.at(incoming, "meta"), "publicSig"), "publishedAt"), 0.0)
	if (incomingAt <= 0) return false
	val localAt = jsNumberOr(Json.at(Json.at(Json.at(localManifest, "meta"), "publicSig"), "publishedAt"), 0.0)
	return incomingAt > localAt
}

/**
 * @param parameters ownerEntityHash / logicalPath / plaintext / name / mimeType / entitySecretKey / entityPubKeyHex / publishedAt
 * @return 已签名并落盘的公开清单
 */
suspend fun publishPublicFile(parameters: Map<String, Any?>): Map<String, Any?> {
	val ownerEntityHash = parameters["ownerEntityHash"] as String
	val logicalPath = parameters["logicalPath"] as String
	@Suppress("UNCHECKED_CAST")
	val plaintext = parameters["plaintext"] as ByteArray
	val name = parameters["name"]
	val mimeType = parameters["mimeType"]
	val entitySecretKey = parameters["entitySecretKey"] as ByteArray
	val entityPubKeyHex = parameters["entityPubKeyHex"] as String
	val publishedAt = if (parameters["publishedAt"] != null)
		jsNumber(parameters["publishedAt"])
	else System.currentTimeMillis().toDouble()

	val base = putFileManifest(
		linkedMapOf(
			"ownerEntityHash" to ownerEntityHash,
			"logicalPath" to logicalPath,
			"plaintext" to plaintext,
			"name" to name,
			"mimeType" to mimeType,
			"ceMode" to "convergent",
			"transferKeyDescriptor" to publicTransferKeyDescriptor(),
		),
	)
	val signed = attachPublicManifestSig(base, publishedAt, entitySecretKey, entityPubKeyHex)
	saveFileManifest(signed)
	return signed
}
