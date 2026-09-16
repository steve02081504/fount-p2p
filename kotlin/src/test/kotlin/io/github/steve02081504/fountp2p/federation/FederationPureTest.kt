package io.github.steve02081504.fountp2p.federation

import org.junit.Assert.assertEquals
import org.junit.Test

/** federation 纯模块（无独立 JS 测试，覆盖基础行为）。 */
class FederationPureTest {
	@Test
	fun `dedupe slot takes first time and expires by ttl`() {
		var now = 0L
		val slot = createDedupeSlot(mapOf("maxSize" to 2, "ttlMs" to 1000)) { now }
		assertEquals(true, slot.take("a"))
		assertEquals(false, slot.take("a"))
		now = 1000
		assertEquals(true, slot.take("a"))
	}

	@Test
	fun `message rate entity key prefers char and rate limits clamp`() {
		assertEquals("char:c1", messageRateEntityKey(mapOf("charId" to "c1", "sender" to "s")))
		assertEquals("s", messageRateEntityKey(mapOf("sender" to "s")))
		assertEquals("", messageRateEntityKey(mapOf("sender" to "")))

		val low = resolveMessageRateLimits(mapOf("messageRateLimitPerMin" to 0, "messageRateLimitWindowMs" to 5000))
		assertEquals(10.0, low["perMin"])
		assertEquals(10_000.0, low["windowMs"])

		val high = resolveMessageRateLimits(mapOf("messageRateLimitPerMin" to 1000, "messageRateLimitWindowMs" to 999_999))
		assertEquals(120.0, high["perMin"])
		assertEquals(999_999.0, high["windowMs"])
	}

	@Test
	fun `volatile stream buffer orders chunks and stops after end`() {
		val buffer = createVolatileStreamBuffer()
		buffer.addChunk("s", 2.0, "b")
		buffer.addChunk("s", 1.0, "a")
		assertEquals(listOf(1.0, 2.0), buffer.listChunks("s").map { it.chunkSeq })
		buffer.end("s")
		buffer.addChunk("s", 3.0, "c")
		assertEquals(listOf(1.0, 2.0), buffer.listChunks("s").map { it.chunkSeq })
		buffer.clear("s")
		assertEquals(emptyList<VolatileChunk>(), buffer.listChunks("s"))
	}

	@Test
	fun `topological order memo caches forces and invalidates`() {
		clearTopologicalOrderMemoForTests()
		var calls = 0
		assertEquals(listOf("a"), resolveTopologicalOrderMemoCached("k", "fp", { calls++; listOf("a") }))
		assertEquals(1, calls)
		assertEquals(listOf("a"), resolveTopologicalOrderMemoCached("k", "fp", { calls++; listOf("b") }))
		assertEquals(1, calls)
		assertEquals(listOf("b"), resolveTopologicalOrderMemoCached("k", "fp", { calls++; listOf("b") }, true))
		assertEquals(2, calls)
		invalidateTopologicalOrderMemo("k")
		assertEquals(listOf("c"), resolveTopologicalOrderMemoCached("k", "fp", { calls++; listOf("c") }))
	}

	@Test
	fun `chunk fetch scheduler assigns rounds and tracks progress`() {
		val assignments = assignChunksToPeers(listOf("h1", "h2", "h3"), listOf("p1", "p2"))
		assertEquals("p1", assignments["h1"])
		assertEquals("p2", assignments["h2"])
		assertEquals("p1", assignments["h3"])

		val table = mutableMapOf<String, ChunkFetchRow>()
		assertEquals(emptyList<String>(), planChunkFetches(table, listOf("h1", "h2"), listOf("p1")).broadcast)
		markChunkInflight(table, "h1", "p1")
		assertEquals("inflight", table["h1"]!!.state)
		assertEquals(1, table["h1"]!!.attempts)
		markChunkDone(table, "h1")
		assertEquals("done", table["h1"]!!.state)
		markChunkFailed(table, "h2")
		assertEquals("failed", table["h2"]!!.state)

		val progress = chunkFetchProgress(table)
		assertEquals(2, progress.total)
		assertEquals(1, progress.done)
		assertEquals(1, progress.failed)

		val retried = mutableMapOf("h1" to ChunkFetchRow("pending", null, 3))
		assertEquals(listOf("h1"), planChunkFetches(retried, listOf("h1"), listOf("p1"), 3).broadcast)
	}
}
