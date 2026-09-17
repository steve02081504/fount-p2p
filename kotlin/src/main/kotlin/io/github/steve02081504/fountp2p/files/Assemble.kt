package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.FEDERATION_CHUNK_MAX_BYTES
import io.github.steve02081504.fountp2p.crypto.ConvergentCipher
import io.github.steve02081504.fountp2p.crypto.encryptConvergentPlaintext
import io.github.steve02081504.fountp2p.crypto.encryptRandomPlaintext
import io.github.steve02081504.fountp2p.crypto.encryptRandomPlaintextWithKey
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.crypto.sha256Hex
import io.github.steve02081504.fountp2p.crypto.wrapContentKey
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.files.manifest.normalizeFileManifest
import io.github.steve02081504.fountp2p.files.manifest.publicTransferKeyDescriptor
import kotlinx.coroutines.yield

/**
 * 明文 → 加密分块 → manifest 组装（等价 `files/assemble.mjs`）。
 */

/** 分块加密结果（`parts` 每项为 `{hash, size, raw, contentHash?}`）。 */
class EncryptPartsResult(
	/** 整块明文 SHA-256 hex */
	val contentHash: String,
	/** 分块元数据（含 raw 密文） */
	val parts: List<Map<String, Any?>>,
	/** random 模式的 contentKey */
	val contentKey: ByteArray?,
)

/** @return 单块加密结果（`{hash,size,raw,contentHash?}`） */
private fun convergentCipherOf(plain: ByteArray, ceMode: String): ConvergentCipher = when (ceMode) {
	"plain" -> {
		val contentHash = sha256Hex(plain)
		ConvergentCipher(contentHash, contentHash, plain)
	}
	"convergent" -> encryptConvergentPlaintext(plain)
	"random" -> encryptRandomPlaintext(plain)
	else -> throw IllegalArgumentException("unknown ceMode: $ceMode")
}

/**
 * @param enc 分块加密结果
 * @param ceMode 模式
 * @return manifest part
 */
private fun partFromEnc(enc: ConvergentCipher, ceMode: String): Map<String, Any?> {
	val part = LinkedHashMap<String, Any?>()
	part["hash"] = enc.ciphertextHash
	part["size"] = enc.raw.size.toDouble()
	part["raw"] = enc.raw
	if (ceMode == "convergent" || ceMode == "plain") part["contentHash"] = enc.contentHash
	return part
}

/**
 * 加密单个分块（random 模式复用调用方提供的 contentKey）。
 * @param slice 明文分块
 * @param ceMode 模式
 * @param contentKey random 模式密钥
 * @return manifest part
 */
fun encryptSliceToPart(slice: ByteArray, ceMode: String, contentKey: ByteArray? = null): Map<String, Any?> {
	val enc = if (ceMode == "random")
		encryptRandomPlaintextWithKey(slice, requireNotNull(contentKey))
	else convergentCipherOf(slice, ceMode)
	return partFromEnc(enc, ceMode)
}

/**
 * @param parts 分块
 * @return 写入 manifest 的 parts
 */
fun manifestPartsForPersist(parts: List<Any?>): List<Map<String, Any?>> {
	val out = ArrayList<Map<String, Any?>>(parts.size)
	for (rawPart in parts) {
		val part = rawPart as? Map<*, *> ?: continue
		val entry = LinkedHashMap<String, Any?>()
		entry["hash"] = part["hash"]
		entry["size"] = part["size"]
		if (jsTruthy(part["contentHash"])) entry["contentHash"] = part["contentHash"]
		out.add(entry)
	}
	return out
}

/**
 * @param plaintext 明文
 * @param ceMode 模式
 * @return 加密结果
 */
fun encryptPlaintextToParts(plaintext: ByteArray, ceMode: String = "convergent"): EncryptPartsResult {
	val enc = convergentCipherOf(plaintext, ceMode)
	return EncryptPartsResult(
		contentHash = enc.contentHash,
		parts = listOf(partFromEnc(enc, ceMode)),
		contentKey = enc.contentKey,
	)
}

/**
 * 将明文拆分为多块加密（大文件）。
 * @param plaintext 明文
 * @param ceMode 模式
 * @return 分块加密结果
 */
fun encryptPlaintextToMultiParts(plaintext: ByteArray, ceMode: String = "convergent"): EncryptPartsResult {
	val contentHash = sha256Hex(plaintext)
	if (plaintext.size <= FEDERATION_CHUNK_MAX_BYTES)
		return encryptPlaintextToParts(plaintext, ceMode)

	val parts = ArrayList<Map<String, Any?>>()
	val contentKey = if (ceMode == "random") randomBytes(32) else null
	val step = FEDERATION_CHUNK_MAX_BYTES.toInt()
	var offset = 0
	while (offset < plaintext.size) {
		val end = minOf(offset + step, plaintext.size)
		parts.add(encryptSliceToPart(plaintext.copyOfRange(offset, end), ceMode, contentKey))
		offset = end
	}
	return EncryptPartsResult(contentHash, parts, contentKey)
}

/**
 * 异步多块加密，周期性让出事件循环。
 * @param plaintext 明文
 * @param ceMode 模式
 * @return 分块加密结果
 */
suspend fun encryptPlaintextToMultiPartsAsync(plaintext: ByteArray, ceMode: String = "convergent"): EncryptPartsResult {
	val contentHash = sha256Hex(plaintext)
	if (plaintext.size <= FEDERATION_CHUNK_MAX_BYTES)
		return encryptPlaintextToParts(plaintext, ceMode)

	val parts = ArrayList<Map<String, Any?>>()
	val contentKey = if (ceMode == "random") randomBytes(32) else null
	val step = FEDERATION_CHUNK_MAX_BYTES.toInt()
	var offset = 0
	while (offset < plaintext.size) {
		if (offset > 0) yield()
		val end = minOf(offset + step, plaintext.size)
		parts.add(encryptSliceToPart(plaintext.copyOfRange(offset, end), ceMode, contentKey))
		offset = end
	}
	return EncryptPartsResult(contentHash, parts, contentKey)
}

/**
 * @param parameters ownerEntityHash/logicalPath/plaintext/name/mimeType/ceMode/transferKeyDescriptor/meta
 * @return manifest（未写盘）
 */
fun buildFileManifest(parameters: Map<String, Any?>): Map<String, Any?> {
	val ownerEntityHash = parameters["ownerEntityHash"]
	val logicalPath = parameters["logicalPath"] as String
	@Suppress("UNCHECKED_CAST")
	val plaintext = parameters["plaintext"] as ByteArray
	val ceMode = jsStringOr(parameters["ceMode"], "convergent")
	val enc = encryptPlaintextToParts(plaintext, ceMode)
	return buildFileManifestFromEnc(
		linkedMapOf(
			"ownerEntityHash" to ownerEntityHash,
			"logicalPath" to logicalPath,
			"plaintext" to plaintext,
			"name" to parameters["name"],
			"mimeType" to (parameters["mimeType"] ?: "application/octet-stream"),
			"ceMode" to ceMode,
			"transferKeyDescriptor" to parameters["transferKeyDescriptor"],
			"meta" to parameters["meta"],
		),
		enc,
	)
}

/**
 * 由已加密分块构建 manifest（vault / file-master-key-wrap 等需自定义 transferKeyDescriptor）。
 * @param parameters 与 [buildFileManifest] 相同字段（不含 plaintext 重加密）
 * @param enc 加密结果
 * @return manifest
 */
fun buildFileManifestFromEnc(parameters: Map<String, Any?>, enc: EncryptPartsResult): Map<String, Any?> {
	val ownerEntityHash = parameters["ownerEntityHash"]
	val logicalPath = parameters["logicalPath"] as String
	@Suppress("UNCHECKED_CAST")
	val plaintext = parameters["plaintext"] as ByteArray
	val ceMode = jsStringOr(parameters["ceMode"], "convergent")
	val name = jsStringOr(parameters["name"], logicalPath.substringAfterLast('/').ifEmpty { "file" })
	val manifest = normalizeFileManifest(
		linkedMapOf(
			"ownerEntityHash" to ownerEntityHash,
			"logicalPath" to logicalPath.replace(Regex("^/+"), ""),
			"name" to name,
			"mimeType" to (parameters["mimeType"] ?: "application/octet-stream"),
			"size" to plaintext.size.toDouble(),
			"contentHash" to enc.contentHash,
			"ceMode" to ceMode,
			"parts" to manifestPartsForPersist(enc.parts),
			"transferKeyDescriptor" to (parameters["transferKeyDescriptor"] ?: publicTransferKeyDescriptor()),
			"meta" to parameters["meta"],
		),
	)
	if (manifest == null) throw IllegalStateException("invalid manifest")
	return manifest
}

/**
 * @param entityHash 所有者
 * @param fileId 文件 ID
 * @param contentKey 随机密钥
 * @param H vault H
 * @return 传输密钥描述
 */
fun vaultWrapDescriptor(entityHash: String, fileId: String, contentKey: ByteArray, H: Any?): Map<String, Any?> =
	linkedMapOf(
		"type" to "vault-wrap",
		"entityHash" to entityHash,
		"fileId" to fileId,
		"wrappedKey" to wrapContentKey(contentKey, H, fileId),
	)
