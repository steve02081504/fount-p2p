package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.dag.readJsonl
import io.github.steve02081504.fountp2p.dag.writeJsonl
import io.github.steve02081504.fountp2p.deleteRecursively
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

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
}
