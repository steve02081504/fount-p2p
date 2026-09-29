package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.dag.jsonlMutexKey
import io.github.steve02081504.fountp2p.dag.readJsonl
import io.github.steve02081504.fountp2p.dag.writeJsonl
import io.github.steve02081504.fountp2p.deleteRecursively
import io.github.steve02081504.fountp2p.utils.withAsyncMutex
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption

/**
 * `timeline/prune.mjs` 与 `timeline/retention.mjs` 行为测试
 * （两个 JS 模块无现成单测，按函数语义编写）。
 */
class PruneRetentionTest {
	private fun hex(c: Char): String = c.toString().repeat(64)

	private fun tempDir(): Path = Files.createTempDirectory("fount-timeline-retention-")

	private fun event(id: String, prev: List<String>, wall: Double, type: String = "message"): Map<String, Any?> =
		linkedMapOf(
			"id" to id,
			"type" to type,
			"prev_event_ids" to prev,
			"hlc" to mapOf("wall" to wall, "logical" to 0.0),
			"node_id" to "node-1",
			"sender" to hex('f'),
		)

	private fun policy(anchorTypes: Set<String> = emptySet()): Map<String, Any?> = linkedMapOf(
		"maxDepth" to 1.0,
		"maxMs" to 1.0,
		"anchorTypes" to anchorTypes,
	)

	@Test
	fun `pruneEventsJsonlAfterCheckpoint returns not pruned without checkpoint`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(path, listOf(event(hex('1'), emptyList(), 1.0)))
			assertEquals(PruneStats(false, 0, 0), pruneEventsJsonlAfterCheckpoint(path, null))
			assertEquals(PruneStats(false, 0, 0), pruneEventsJsonlAfterCheckpoint(path, mapOf("checkpoint_event_id" to null)))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `pruneEventsJsonlAfterCheckpoint keeps all when tip absent from events`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(path, listOf(event(hex('1'), emptyList(), 1.0), event(hex('2'), listOf(hex('1')), 2.0)))
			val stats = pruneEventsJsonlAfterCheckpoint(path, mapOf("checkpoint_event_id" to hex('9')))
			assertEquals(PruneStats(false, 2, 0), stats)
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `pruneEventsJsonlAfterCheckpoint drops disconnected orphans`() = runBlocking {
		val dir = tempDir()
		try {
			val root = hex('0')
			val left = hex('1')
			val right = hex('2')
			val tip = hex('3')
			val orphan = hex('4')
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(
				path,
				listOf(
					event(tip, listOf(left, right), 5.0),
					event(orphan, listOf(left), 6.0),
					event(left, listOf(root), 2.0),
					event(right, listOf(root), 3.0),
					event(root, emptyList(), 1.0),
				),
			)

			val stats = pruneEventsJsonlAfterCheckpoint(path, mapOf("checkpoint_event_id" to tip))

			assertEquals(PruneStats(true, 1, 4), stats)
			assertEquals(listOf(tip), readJsonl(path).map { it["id"] })
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `pruneEventsJsonlAfterCheckpoint keeps all when checkpoint is root`() = runBlocking {
		val dir = tempDir()
		try {
			val root = hex('0')
			val child = hex('1')
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(path, listOf(event(child, listOf(root), 2.0), event(root, emptyList(), 1.0)))

			val stats = pruneEventsJsonlAfterCheckpoint(path, mapOf("checkpoint_event_id" to root))

			assertEquals(PruneStats(false, 2, 0), stats)
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `enforceTimelineEventRetention returns not pruned for empty file`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl").toString()
			assertEquals(
				PruneStats(false, 0, 0),
				enforceTimelineEventRetention(path, null, policy()),
			)
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `enforceTimelineEventRetention maxDepth floor keeps short chains`() = runBlocking {
		val dir = tempDir()
		try {
			val e1 = hex('1')
			val e2 = hex('2')
			val e3 = hex('3')
			val e4 = hex('4')
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(
				path,
				listOf(
					event(e1, emptyList(), 1.0),
					event(e2, listOf(e1), 2.0),
					event(e3, listOf(e2), 3.0),
					event(e4, listOf(e3), 4.0),
				),
			)

			val stats = enforceTimelineEventRetention(path, null, policy())

			assertEquals(PruneStats(false, 4, 0), stats)
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `enforceTimelineEventRetention keeps checkpoint descendant closure`() = runBlocking {
		val dir = tempDir()
		try {
			val e1 = hex('1')
			val e2 = hex('2')
			val e3 = hex('3')
			val e4 = hex('4')
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(
				path,
				listOf(
					event(e1, emptyList(), 1.0),
					event(e2, listOf(e1), 2.0),
					event(e3, listOf(e2), 3.0),
					event(e4, listOf(e3), 4.0),
				),
			)

			val stats = enforceTimelineEventRetention(
				path,
				mapOf("checkpoint_event_id" to e2),
				policy(),
			)

			assertEquals(PruneStats(true, 3, 1), stats)
			assertEquals(listOf(e2, e3, e4), readJsonl(path).map { it["id"] })
		}
		finally {
			deleteRecursively(dir)
		}
	}

	private fun stripReceivedAt(row: Map<String, Any?>): Map<String, Any?> =
		LinkedHashMap(row).apply { remove("receivedAt") }

	private fun rawLines(path: String): List<String> =
		Files.readString(Path.of(path)).lines().filter { it.isNotBlank() }

	@Test
	fun `pruneEventsJsonlAfterCheckpoint preserves raw lines stripped by sanitize`() = runBlocking {
		val dir = tempDir()
		try {
			val tip = hex('1')
			val child = hex('2')
			val orphan = hex('3')
			val path = dir.resolve("events.jsonl").toString()
			val tipRaw = Json.stringify(event(tip, emptyList(), 1.0) + mapOf("receivedAt" to 111.0))!!
			val childRaw = Json.stringify(event(child, listOf(tip), 2.0) + mapOf("receivedAt" to 222.0))!!
			val orphanRaw = Json.stringify(event(orphan, emptyList(), 3.0))!!
			Files.writeString(Path.of(path), listOf(tipRaw, childRaw, orphanRaw).joinToString("\n") + "\n")

			val stats = pruneEventsJsonlAfterCheckpoint(path, mapOf("checkpoint_event_id" to tip), ::stripReceivedAt)

			assertEquals(PruneStats(true, 2, 1), stats)
			assertEquals(listOf(tipRaw, childRaw), rawLines(path))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `enforceTimelineEventRetention preserves raw lines stripped by sanitize`() = runBlocking {
		val dir = tempDir()
		try {
			val e1 = hex('1')
			val e2 = hex('2')
			val e3 = hex('3')
			val e4 = hex('4')
			val path = dir.resolve("events.jsonl").toString()
			val e1Raw = Json.stringify(event(e1, emptyList(), 1.0))!!
			val e2Raw = Json.stringify(event(e2, listOf(e1), 2.0))!!
			val e3Raw = Json.stringify(event(e3, listOf(e2), 3.0) + mapOf("receivedAt" to 333.0))!!
			val e4Raw = Json.stringify(event(e4, listOf(e3), 4.0))!!
			Files.writeString(Path.of(path), listOf(e1Raw, e2Raw, e3Raw, e4Raw).joinToString("\n") + "\n")

			val stats = enforceTimelineEventRetention(
				path,
				mapOf("checkpoint_event_id" to e2),
				policy(),
				::stripReceivedAt,
			)

			assertEquals(PruneStats(true, 3, 1), stats)
			assertEquals(listOf(e2Raw, e3Raw, e4Raw), rawLines(path))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `pruneEventsJsonlAfterCheckpoint reads events under the jsonl mutex`() = runBlocking {
		val dir = tempDir()
		try {
			val root = hex('0')
			val tip = hex('1')
			val orphan = hex('2')
			val child = hex('3')
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(
				path,
				listOf(event(root, emptyList(), 1.0), event(tip, listOf(root), 2.0), event(orphan, emptyList(), 1.5)),
			)
			val childRaw = Json.stringify(event(child, listOf(tip), 3.0))!!

			val job = withAsyncMutex(jsonlMutexKey(path)) {
				val started = launch { pruneEventsJsonlAfterCheckpoint(path, mapOf("checkpoint_event_id" to tip)) }
				yield()
				Files.writeString(Path.of(path), childRaw + "\n", StandardOpenOption.APPEND)
				started
			}
			job.join()

			assertTrue(rawLines(path).contains(childRaw))
			assertEquals(listOf(tip, child), readJsonl(path).map { it["id"] })
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `enforceTimelineEventRetention reads events under the jsonl mutex`() = runBlocking {
		val dir = tempDir()
		try {
			val e1 = hex('1')
			val e2 = hex('2')
			val e3 = hex('3')
			val e4 = hex('4')
			val e5 = hex('5')
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(
				path,
				listOf(
					event(e1, emptyList(), 1.0),
					event(e2, listOf(e1), 2.0),
					event(e3, listOf(e2), 3.0),
					event(e4, listOf(e3), 4.0),
				),
			)
			val e5Raw = Json.stringify(event(e5, listOf(e4), 5.0))!!

			val job = withAsyncMutex(jsonlMutexKey(path)) {
				val started = launch {
					enforceTimelineEventRetention(path, mapOf("checkpoint_event_id" to e2), policy())
				}
				yield()
				Files.writeString(Path.of(path), e5Raw + "\n", StandardOpenOption.APPEND)
				started
			}
			job.join()

			assertTrue(rawLines(path).contains(e5Raw))
			assertEquals(listOf(e2, e3, e4, e5), readJsonl(path).map { it["id"] })
		}
		finally {
			deleteRecursively(dir)
		}
	}
}
