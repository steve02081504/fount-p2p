package io.github.steve02081504.fountp2p

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import java.nio.file.Files
import java.nio.file.Path

/** 固定 seed 生成的测试身份（等价 JS `test/helpers/identity.mjs`）。 */
data class TestIdentity(val nodeHash: String, val nodePubKey: String, val secretKey: ByteArray) {
	override fun equals(other: Any?): Boolean =
		other is TestIdentity && nodeHash == other.nodeHash && nodePubKey == other.nodePubKey &&
			secretKey.contentEquals(other.secretKey)

	override fun hashCode(): Int = (nodeHash.hashCode() * 31 + nodePubKey.hashCode()) * 31 + secretKey.contentHashCode()
}

/** @param fill seed 填充字节值 @return 节点身份 */
fun identity(fill: Int): TestIdentity {
	val keyPair = keyPairFromSeed(ByteArray(32) { fill.toByte() })
	return TestIdentity(pubKeyHash(keyPair.publicKey), bytesToHex(keyPair.publicKey), keyPair.secretKey)
}

/** 递归删除目录（测试清理）。 */
fun deleteRecursively(path: Path) {
	if (!Files.exists(path)) return
	Files.walk(path).use { stream ->
		stream.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
	}
}
