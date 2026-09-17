package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.dag.computeLocalTipsHash
import io.github.steve02081504.fountp2p.dag.eventsToMetas
import io.github.steve02081504.fountp2p.dag.topologicalCanonicalOrder
import io.github.steve02081504.fountp2p.deleteRecursively
import io.github.steve02081504.fountp2p.governance.computeDagTipIdsFromEvents
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/** `federation/dag_order_cache.mjs` 行为测试（该 JS 模块无现成单测，按函数语义编写）。 */
class DagOrderCacheTest {
	private fun hex(c: Char): String = c.toString().repeat(64)

	private fun tempDir(): Path = Files.createTempDirectory("fount-order-cache-")

	private fun event(id: String, prev: List<String>, wall: Double): Map<String, Any?> = linkedMapOf(
		"id" to id,
		"prev_event_ids" to prev,
		"hlc" to mapOf("wall" to wall, "logical" to 0.0),
		"node_id" to "node-1",
		"sender" to hex('f'),
	)

	private val root = hex('0')
	private val first = hex('1')
	private val second = hex('2')

	private fun chain(): List<Map<String, Any?>> = listOf(
		event(root, emptyList(), 1.0),
		event(first, listOf(root), 2.0),
		event(second, listOf(first), 3.0),
	)

	@Test
	fun `buildOrderCachePayload builds order tipsHash and eventCount`() {
		val events = chain()
		val order = topologicalCanonicalOrder(eventsToMetas(events))

		val payload = buildOrderCachePayload(order, events)

		assertEquals(listOf(root, first, second), payload["order"])
		assertEquals(computeLocalTipsHash(computeDagTipIdsFromEvents(events)), payload["tipsHash"])
		assertEquals(3.0, payload["eventCount"])
	}

	@Test
	fun `mergeTopologicalOrder appends new suffix after cached prefix`() {
		val events = chain()
		val merged = mergeTopologicalOrder(listOf(root, first), events)
		assertEquals(listOf(root, first, second), merged)
	}

	@Test
	fun `mergeTopologicalOrder inserts independent event after its parent`() {
		val events = listOf(
			event(root, emptyList(), 1.0),
			event(first, listOf(root), 2.0),
			event(second, listOf(root), 3.0),
		)

		val merged = mergeTopologicalOrder(listOf(first, root), events)

		assertEquals(listOf(first, root, second), merged)
	}

	@Test
	fun `resolveEventTopologicalOrder returns empty for empty events`() {
		assertEquals(emptyList<String>(), resolveEventTopologicalOrder(emptyList(), null))
	}

	@Test
	fun `resolveEventTopologicalOrder forceFull ignores cache`() {
		val events = chain()
		val staleCache = linkedMapOf<String, Any?>(
			"order" to listOf(second, first, root),
			"tipsHash" to "stale",
			"eventCount" to 3.0,
		)

		val order = resolveEventTopologicalOrder(events, staleCache, mapOf("forceFull" to true))

		assertEquals(listOf(root, first, second), order)
	}

	@Test
	fun `resolveEventTopologicalOrder reuses matching cache`() {
		val events = chain()
		val order = topologicalCanonicalOrder(eventsToMetas(events))
		val cache = buildOrderCachePayload(order, events)

		assertEquals(order, resolveEventTopologicalOrder(events, cache))
	}

	@Test
	fun `resolveEventTopologicalOrder merges partial cache`() {
		val events = chain()
		val partialCache = linkedMapOf<String, Any?>(
			"order" to listOf(root, first),
			"tipsHash" to "stale",
			"eventCount" to 2.0,
		)

		assertEquals(listOf(root, first, second), resolveEventTopologicalOrder(events, partialCache))
	}

	@Test
	fun `readOrderCache returns null for missing invalid and non object`() = runBlocking {
		val dir = tempDir()
		try {
			assertNull(readOrderCache(dir.resolve("missing.json").toString()))
			val invalid = dir.resolve("invalid.json")
			Files.writeString(invalid, "not json")
			assertNull(readOrderCache(invalid.toString()))
			val array = dir.resolve("array.json")
			Files.writeString(array, "[1,2]")
			assertNull(readOrderCache(array.toString()))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `writeOrderCache and readOrderCache roundtrip`() = runBlocking {
		val dir = tempDir()
		try {
			val events = chain()
			val order = topologicalCanonicalOrder(eventsToMetas(events))
			val payload = buildOrderCachePayload(order, events)
			val path = dir.resolve("nested/events.order.json").toString()

			writeOrderCache(path, payload)

			assertEquals(payload, readOrderCache(path))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `deleteOrderCache removes file and ignores missing`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.order.json")
			Files.writeString(path, "{}")
			deleteOrderCache(path.toString())
			assertEquals(false, Files.exists(path))
			deleteOrderCache(path.toString())
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `writeOrderCache swallows write errors`() = runBlocking {
		val dir = tempDir()
		try {
			val blocker = dir.resolve("blocker")
			Files.writeString(blocker, "x")
			val badPath = blocker.resolve("child.json").toString()

			writeOrderCache(badPath, mapOf("order" to emptyList<String>()))

			assertNull(readOrderCache(badPath))
		}
		finally {
			deleteRecursively(dir)
		}
	}
}
