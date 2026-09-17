package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.files.chunk.pendingChunkFetches
import io.github.steve02081504.fountp2p.files.manifest.pendingManifestFetches
import io.github.steve02081504.fountp2p.trust_graph.TrustGraphProvider
import io.github.steve02081504.fountp2p.trust_graph.TrustNode
import kotlinx.coroutines.delay

/** `files/` 测试共用桩（等价 JS `test/helpers` 中相关部分）。 */

/** 记录 send/fanout 的 trust graph provider。 */
internal class MockTrustGraph {
	val sent = ArrayList<String>()
	val sentPayloads = ArrayList<Any?>()
	val fanouts = ArrayList<String>()
	val fanoutPayloads = ArrayList<Any?>()
	val fanoutLimits = ArrayList<Int?>()

	val provider = object : TrustGraphProvider {
		override suspend fun buildMergedGraph(username: String): Map<String, TrustNode> = emptyMap()

		override suspend fun pickTopNodes(username: String, limit: Int): List<TrustNode> = emptyList()

		override suspend fun sendToNode(
			username: String,
			targetNodeHash: String,
			actionName: String,
			payload: Any?,
			graph: Map<String, TrustNode>?,
		): Boolean {
			sent.add(targetNodeHash)
			sentPayloads.add(payload)
			return true
		}

		override suspend fun fanoutToTopNodes(
			username: String,
			actionName: String,
			payload: Any?,
			limit: Int?,
		): Int {
			fanouts.add(actionName)
			fanoutPayloads.add(payload)
			fanoutLimits.add(limit)
			return 0
		}
	}
}

/**
 * @param predicate 条件
 * @param timeoutMs 等待上限
 */
internal suspend fun waitUntil(timeoutMs: Long = 2_000, predicate: () -> Boolean) {
	val deadline = System.currentTimeMillis() + timeoutMs
	while (System.currentTimeMillis() < deadline) {
		if (predicate()) return
		delay(5)
	}
	throw IllegalStateException("waitUntil timeout")
}

/** 结算残留 chunk pending，避免测试残留污染后续用例。 */
internal fun settleAllPendingChunkFetches() {
	for (key in pendingChunkFetches.keys.toList()) {
		val entry = pendingChunkFetches[key] ?: continue
		entry.timeout?.cancel(false)
		pendingChunkFetches.remove(key)
		entry.finish(null)
	}
}

/** 结算残留 manifest pending，避免 SWR 提前返回后的 fanout 污染后续用例。 */
internal fun settleAllPendingManifestFetches() {
	for (key in pendingManifestFetches.keys.toList()) {
		val entry = pendingManifestFetches[key] ?: continue
		entry.timeout?.cancel(false)
		pendingManifestFetches.remove(key)
		entry.finish(null)
	}
}

/** 测试用 recovery 密钥对。 */
internal class TestRecoveryKeys(val secretKey: ByteArray, val publicKey: ByteArray, val pubKeyHex: String)

/**
 * @param n 种子盐
 * @return 测试用 recovery 密钥对
 */
internal fun testRecoveryKeys(n: Int): TestRecoveryKeys {
	val seed = "public-manifest-test-seed-$n".padEnd(32, '0')
	val keyPair = keyPairFromSeed(seed.toByteArray(Charsets.UTF_8))
	return TestRecoveryKeys(keyPair.secretKey, keyPair.publicKey, bytesToHex(keyPair.publicKey))
}
