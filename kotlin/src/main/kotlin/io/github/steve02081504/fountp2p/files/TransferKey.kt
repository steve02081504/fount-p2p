package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.decryptConvergentCiphertext
import io.github.steve02081504.fountp2p.crypto.decryptRandomCiphertext
import io.github.steve02081504.fountp2p.crypto.sha256
import io.github.steve02081504.fountp2p.crypto.unwrapContentKey
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy

/**
 * 传输密钥解析与分块解密（等价 `files/transfer_key.mjs`）。
 */

/** 已绑定副本用户名的密钥源。 */
class ContentKeyDependencies(
	/** random / wrap 的群文件主密钥源 */
	val getGroupFileMasterKey: (suspend (groupId: String, keyGeneration: Double?) -> ByteArray?)? = null,
	/** vault 主密钥源 */
	val getVaultMasterKey: (suspend (entityHash: String) -> ByteArray?)? = null,
)

/**
 * @param descriptor 传递密钥描述符
 * @param manifest manifest
 * @param dependencies 密钥源
 * @return contentKey；plain/convergent 返回 null（按 contentHash 派生）
 */
suspend fun resolveContentKey(
	descriptor: Any?,
	manifest: Map<String, Any?>,
	dependencies: ContentKeyDependencies = ContentKeyDependencies(),
): ByteArray? {
	val descriptorMap = descriptor as? Map<*, *>
	val type = jsStringOr(descriptorMap?.get("type"), "public")
	val ceMode = jsString(manifest["ceMode"])
	if (type == "public" || ceMode == "plain" || ceMode == "convergent") return null

	if (type == "file-master-key-wrap") {
		val groupId = jsStringOr(descriptorMap?.get("groupId"), "")
		val fileId = jsStringOr(descriptorMap?.get("fileId"), "")
		val wrappedKey = descriptorMap?.get("wrappedKey")
		if (!jsTruthy(groupId) || !jsTruthy(fileId) || !jsTruthy(wrappedKey)) return null
		val getter = dependencies.getGroupFileMasterKey ?: return null
		val keyGeneration = if (descriptorMap?.get("keyGeneration") != null)
			jsNumber(descriptorMap["keyGeneration"]) else null
		val groupKey = getter(groupId, keyGeneration) ?: return null
		return unwrapContentKey(wrappedKey, groupKey, fileId)
	}

	if (type == "vault-wrap") {
		val entityHash = jsStringOr(descriptorMap?.get("entityHash"), "")
		val fileId = jsStringOr(descriptorMap?.get("fileId"), "")
		val wrappedKey = descriptorMap?.get("wrappedKey")
		if (!jsTruthy(entityHash) || !jsTruthy(fileId) || !jsTruthy(wrappedKey)) return null
		val getter = dependencies.getVaultMasterKey ?: return null
		val vaultKey = getter(entityHash) ?: return null
		return unwrapContentKey(wrappedKey, vaultKey, fileId)
	}

	return null
}

/**
 * @param encryptedPartBytes 密文块
 * @param manifest manifest
 * @param contentKey random 模式密钥
 * @param partIndex 分块下标（多块 convergent 用 part.contentHash）
 * @return 明文；失败为 null
 */
fun decryptPart(
	encryptedPartBytes: ByteArray,
	manifest: Map<String, Any?>,
	contentKey: ByteArray?,
	partIndex: Int = 0,
): ByteArray? {
	val ceMode = manifest["ceMode"]
	if (ceMode == "plain") return encryptedPartBytes.copyOf()

	if (ceMode == "convergent") {
		@Suppress("UNCHECKED_CAST")
		val parts = manifest["parts"] as? List<Any?> ?: emptyList()
		val part = parts.getOrNull(partIndex) as? Map<*, *>
		val partPlainHash = if (jsTruthy(part?.get("contentHash"))) jsString(part!!["contentHash"])
		else jsString(manifest["contentHash"])
		return decryptConvergentCiphertext(encryptedPartBytes, partPlainHash)
	}

	if (ceMode == "random" && contentKey != null) {
		// 多块时各块明文 hash ≠ 整文件 contentHash；完整性在 assemble 末尾校验
		@Suppress("UNCHECKED_CAST")
		val parts = manifest["parts"] as? List<Any?> ?: emptyList()
		val verifyHash = if (parts.size == 1) jsString(manifest["contentHash"]) else ""
		return decryptRandomCiphertext(encryptedPartBytes, contentKey, verifyHash)
	}

	return null
}

/**
 * @param manifest manifest
 * @param partBytes 按序密文块
 * @param dependencies 密钥源
 * @return 完整明文；失败为 null
 */
suspend fun assembleManifestPlaintext(
	manifest: Map<String, Any?>,
	partBytes: List<ByteArray>,
	dependencies: ContentKeyDependencies = ContentKeyDependencies(),
): ByteArray? {
	@Suppress("UNCHECKED_CAST")
	val parts = manifest["parts"] as? List<Any?> ?: emptyList()
	if (partBytes.size != parts.size) return null
	val contentKey = resolveContentKey(manifest["transferKeyDescriptor"], manifest, dependencies)
	var merged = ByteArray(0)
	for (index in parts.indices) {
		val plain = decryptPart(partBytes[index], manifest, contentKey, index) ?: return null
		merged += plain
	}
	if (jsTruthy(manifest["contentHash"]))
		if (bytesToHex(sha256(merged)) != manifest["contentHash"]) return null
	return merged
}
