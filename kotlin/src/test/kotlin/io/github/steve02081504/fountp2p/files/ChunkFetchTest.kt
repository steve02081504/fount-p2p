package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.crypto.sha256Hex
import io.github.steve02081504.fountp2p.files.chunk.chunkBytesMatchHash
import io.github.steve02081504.fountp2p.files.chunk.fetchChunk
import io.github.steve02081504.fountp2p.files.chunk.pendingChunkFetches
import io.github.steve02081504.fountp2p.files.chunk.registerChunkFetchWait
import io.github.steve02081504.fountp2p.files.chunk.resolvePendingChunkFetch
import io.github.steve02081504.fountp2p.files.chunk.verifiedChunkBytes
import io.github.steve02081504.fountp2p.node.withTempNode
import io.github.steve02081504.fountp2p.trust_graph.DEFAULT_TRUST_GRAPH_OWNER
import io.github.steve02081504.fountp2p.trust_graph.clearTrustGraphProvider
import io.github.steve02081504.fountp2p.trust_graph.registerTrustGraphProvider
import io.github.steve02081504.fountp2p.utils.ms
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `js/test/pure/chunk_fetch.test.mjs`。 */
class ChunkFetchTest {
	private val goodBytes = "chunk-payload".toByteArray(Charsets.UTF_8)
	private val hash = sha256Hex(goodBytes)
	private val badBytes = "wrong-payload".toByteArray(Charsets.UTF_8)

	@Test
	fun `chunkBytesMatchHash accepts matching digest`() {
		assertEquals(true, chunkBytesMatchHash(hash, goodBytes))
		assertEquals(goodBytes.size, verifiedChunkBytes(hash, goodBytes)?.size)
	}

	@Test
	fun `chunkBytesMatchHash rejects mismatched digest`() {
		assertEquals(false, chunkBytesMatchHash(hash, badBytes))
		assertNull(verifiedChunkBytes(hash, badBytes))
	}

	@Test
	fun `resolvePendingChunkFetch ignores hash mismatch until valid response`() = runBlocking {
		settleAllPendingChunkFetches()
		val requestId = "req-mismatch-then-match"
		val handle = registerChunkFetchWait(requestId, hash, ms("1m"))
		resolvePendingChunkFetch(mapOf("requestId" to requestId, "dataBase64" to bytesToBase64(badBytes)))
		assertEquals(false, handle.done.isCompleted)
		assertEquals(true, pendingChunkFetches.containsKey(requestId))
		resolvePendingChunkFetch(mapOf("requestId" to requestId, "dataBase64" to bytesToBase64(goodBytes)))
		assertEquals(goodBytes.size, handle.done.await()?.size)
		assertEquals(false, pendingChunkFetches.containsKey(requestId))
	}

	@Test
	fun `resolvePendingChunkFetch ignores empty response without data`() = runBlocking {
		settleAllPendingChunkFetches()
		val requestId = "req-empty-neg"
		val handle = registerChunkFetchWait(requestId, hash, ms("1m"))
		// 无 dataBase64 不得视为“未找到”而提前结算。
		assertEquals(false, resolvePendingChunkFetch(mapOf("requestId" to requestId)))
		assertEquals(false, handle.done.isCompleted)
		assertEquals(true, pendingChunkFetches.containsKey(requestId))
		resolvePendingChunkFetch(mapOf("requestId" to requestId, "dataBase64" to bytesToBase64(goodBytes)))
		assertEquals(goodBytes.size, handle.done.await()?.size)
	}

	@Test
	fun `resolvePendingChunkFetch accepts matching hash`() = runBlocking {
		settleAllPendingChunkFetches()
		val requestId = "req-match"
		val handle = registerChunkFetchWait(requestId, hash, ms("1m"))
		resolvePendingChunkFetch(mapOf("requestId" to requestId, "dataBase64" to bytesToBase64(goodBytes)))
		assertEquals(goodBytes.size, handle.done.await()?.size)
	}

	@Test
	fun `fetchChunk with fanoutTargets sends only to canonical targets, no node-scope fanout`() = runBlocking {
		settleAllPendingChunkFetches()
		withTempNode("fount-chunk-tgt-") {
			val mock = MockTrustGraph()
			registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
			try {
				val targetNodeHash = "a".repeat(64)
				val chunkData = "targeted-chunk".toByteArray(Charsets.UTF_8)
				val chunkHash = sha256Hex(chunkData)
				coroutineScope {
					val fetchDeferred = async {
						fetchChunk(
							mapOf(
								"username" to "u",
								"ciphertextHash" to chunkHash,
								"ownerEntityHash" to "b".repeat(64),
								"fanoutTargets" to listOf(targetNodeHash, targetNodeHash, "not-hex", ""),
							),
						)
					}
					waitUntil { mock.sent.isNotEmpty() }
					assertEquals(1, mock.sent.size)
					assertEquals(targetNodeHash, mock.sent[0])
					assertEquals(0, mock.fanouts.size)
					// 定向 fanout 后注入匹配响应，结算等待
					val requestId = pendingChunkFetches.keys.first()
					assertEquals(true, requestId.isNotEmpty())
					assertEquals(
						true,
						resolvePendingChunkFetch(mapOf("requestId" to requestId, "dataBase64" to bytesToBase64(chunkData))),
					)
					assertEquals(chunkData.size, fetchDeferred.await()?.size)
				}
			}
			finally {
				settleAllPendingChunkFetches()
				clearTrustGraphProvider()
			}
		}
	}

	@Test
	fun `fetchChunk without fanoutTargets keeps node-scope fanoutToTopNodes`() = runBlocking {
		settleAllPendingChunkFetches()
		withTempNode("fount-chunk-scope-") {
			val mock = MockTrustGraph()
			registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
			try {
				val chunkData = "public-chunk".toByteArray(Charsets.UTF_8)
				val chunkHash = sha256Hex(chunkData)
				coroutineScope {
					val fetchDeferred = async {
						fetchChunk(
							mapOf(
								"username" to "u",
								"ciphertextHash" to chunkHash,
								"ownerEntityHash" to "c".repeat(64),
							),
						)
					}
					waitUntil { mock.fanouts.isNotEmpty() }
					assertEquals("fed_chunk_get", mock.fanouts[0])
					val requestId = pendingChunkFetches.keys.first()
					assertEquals(true, requestId.isNotEmpty())
					assertEquals(
						true,
						resolvePendingChunkFetch(mapOf("requestId" to requestId, "dataBase64" to bytesToBase64(chunkData))),
					)
					assertEquals(chunkData.size, fetchDeferred.await()?.size)
				}
			}
			finally {
				settleAllPendingChunkFetches()
				clearTrustGraphProvider()
			}
		}
	}

	@Test
	fun `fetchChunk targeted and public modes dedup separately by inflight key`() = runBlocking {
		settleAllPendingChunkFetches()
		withTempNode("fount-chunk-key-") {
			val mock = MockTrustGraph()
			registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
			try {
				val chunkData = "dedup-chunk".toByteArray(Charsets.UTF_8)
				val chunkHash = sha256Hex(chunkData)
				val targetNodeHash = "d".repeat(64)
				coroutineScope {
					val targetedDeferred = async {
						fetchChunk(
							mapOf(
								"username" to "u",
								"ciphertextHash" to chunkHash,
								"ownerEntityHash" to "e".repeat(64),
								"fanoutTargets" to listOf(targetNodeHash),
							),
						)
					}
					val publicDeferred = async {
						fetchChunk(
							mapOf(
								"username" to "u",
								"ciphertextHash" to chunkHash,
								"ownerEntityHash" to "e".repeat(64),
							),
						)
					}
					waitUntil { pendingChunkFetches.size == 2 }
					// 两个模式各一个 pending：targeted 只发目标集，public 走 node-scope
					assertEquals(1, mock.sent.count { it == targetNodeHash })
					assertEquals(1, mock.fanouts.size)
					// 分别结算
					for (requestId in pendingChunkFetches.keys.toList())
						resolvePendingChunkFetch(mapOf("requestId" to requestId, "dataBase64" to bytesToBase64(chunkData)))
					assertEquals(chunkData.size, targetedDeferred.await()?.size)
					assertEquals(chunkData.size, publicDeferred.await()?.size)
				}
			}
			finally {
				settleAllPendingChunkFetches()
				clearTrustGraphProvider()
			}
		}
	}
}
