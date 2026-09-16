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
 * `timeline/retention_runner.mjs` 行为测试（该 JS 模块无现成单测，按函数语义编写）。
 */
class RetentionRunnerTest {
	private fun hex(c: Char): String = c.toString().repeat(64)

	private fun tempDir(): Path = Files.createTempDirectory("fount-timeline-runner-")

	private fun event(id: String, prev: List<String>, wall: Double): Map<String, Any?> = linkedMapOf(
		"id" to id,
		"type" to "message",
		"prev_event_ids" to prev,
		"hlc" to mapOf("wall" to wall, "logical" to 0.0),
		"node_id" to "node-1",
		"sender" to hex('f'),
	)

	private fun policy(): Map<String, Any?> = linkedMapOf(
		"maxDepth" to 1.0,
		"maxMs" to 1.0,
		"anchorTypes" to emptySet<String>(),
	)

	@Test
	fun `enforceDagRetention reads checkpoint from callback`() = runBlocking {
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

			val stats = enforceDagRetention(
				path,
				{ mapOf<String, Any?>("checkpoint_event_id" to e2) },
				policy(),
			)

			assertEquals(PruneStats(true, 3, 1), stats)
			assertEquals(listOf(e2, e3, e4), readJsonl(path).map { it["id"] })
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `runTimelineMaintenance compacts after retention when above trigger`() = runBlocking {
		val dir = tempDir()
		try {
			val ids = (1..5).map { hex('0' + it) }
			val now = System.currentTimeMillis().toDouble()
			val events = ArrayList<Map<String, Any?>>()
			for ((index, id) in ids.withIndex())
				events.add(event(id, if (index == 0) emptyList() else listOf(ids[index - 1]), now))
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(path, events)

			runTimelineMaintenance(
				eventsFilePath = path,
				checkpoint = mapOf("checkpoint_event_id" to ids[2]),
				policy = policy(),
				sanitize = { it },
				compactTrigger = 3.0,
			)

			assertEquals(listOf(ids[2], ids[3], ids[4]), readJsonl(path).map { it["id"] })
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `runTimelineMaintenance skips compaction without checkpoint id`() = runBlocking {
		val dir = tempDir()
		try {
			val ids = (1..5).map { hex('0' + it) }
			val now = System.currentTimeMillis().toDouble()
			val events = ArrayList<Map<String, Any?>>()
			for ((index, id) in ids.withIndex())
				events.add(event(id, if (index == 0) emptyList() else listOf(ids[index - 1]), now))
			val path = dir.resolve("events.jsonl").toString()
			writeJsonl(path, events)

			runTimelineMaintenance(
				eventsFilePath = path,
				checkpoint = null,
				policy = policy(),
				sanitize = { it },
				compactTrigger = 3.0,
			)

			assertEquals(ids, readJsonl(path).map { it["id"] })
		}
		finally {
			deleteRecursively(dir)
		}
	}
}
