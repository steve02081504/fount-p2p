package io.github.steve02081504.fountp2p.files.chunk

import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.crypto.sha256Hex

/**
 * chunk 内容校验（等价 `files/chunk/verify.mjs`）。
 */

/**
 * @param chunkHash 期望的 64 hex 密文哈希
 * @param data 块字节
 * @return 是否与 hash 一致
 */
fun chunkBytesMatchHash(chunkHash: String?, data: ByteArray?): Boolean {
	if (isHex64(chunkHash) == null || data == null || data.isEmpty()) return false
	return sha256Hex(data) == chunkHash
}

/**
 * @param chunkHash 期望哈希
 * @param data 块字节
 * @return 校验通过的数据；否则 null
 */
fun verifiedChunkBytes(chunkHash: String?, data: ByteArray?): ByteArray? {
	if (!chunkBytesMatchHash(chunkHash, data)) return null
	return data
}
