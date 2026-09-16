package io.github.steve02081504.fountp2p.wire

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 对应 `js/wire/wait.mjs` 的等价测试。 */
class WaitTest {
	private val prefixSeparator = "\u0000"

	@Test
	fun `registerWireWait resolves before timeout and clears the pending slot`() = runBlocking {
		val pending = LinkedHashMap<String, WireWaiter>()
		val handle = registerWireWait(pending, "key", 5_000) { "timeout" }
		assertEquals(1, pending.size)
		handle.resolve("value")
		assertEquals("value", handle.promise.await())
		assertTrue(pending.isEmpty())
	}

	@Test
	fun `registerWireWait falls back to the timeout value`() = runBlocking {
		val pending = LinkedHashMap<String, WireWaiter>()
		val handle = registerWireWait(pending, "key", 50) { "timeout" }
		assertEquals("timeout", handle.promise.await())
		assertTrue(pending.isEmpty())
	}

	@Test
	fun `finishMultiWireWaiters wakes every waiter for the suffix key`() = runBlocking {
		val pending = LinkedHashMap<String, MutableMap<String, MutableList<WireWaiter>>>()
		val first = registerMultiWireWait(pending, "prefix$prefixSeparator", "group-a", 5_000)
		val second = registerMultiWireWait(pending, "prefix$prefixSeparator", "group-a", 5_000)
		finishMultiWireWaiters(pending, "prefix$prefixSeparator", "group-a")
		assertNull(first.await())
		assertNull(second.await())
		assertTrue(pending.isEmpty())
	}

	@Test
	fun `notifyMultiWireWaitersByPrefix wakes only matching suffix buckets`() = runBlocking {
		val prefix = "prefix$prefixSeparator"
		val pending = LinkedHashMap<String, MutableMap<String, MutableList<WireWaiter>>>()
		val hit = registerMultiWireWait(pending, prefix, "a${prefixSeparator}b", 5_000)
		val miss = registerMultiWireWait(pending, prefix, "c${prefixSeparator}d", 5_000)
		notifyMultiWireWaitersByPrefix(pending, prefix, setOf("b")) { suffix ->
			suffix.split(prefixSeparator)
		}
		assertNull(hit.await())
		assertFalse(miss.isCompleted)
		finishMultiWireWaiters(pending, prefix, "c${prefixSeparator}d")
		assertNull(miss.await())
		assertTrue(pending.isEmpty())
	}
}
