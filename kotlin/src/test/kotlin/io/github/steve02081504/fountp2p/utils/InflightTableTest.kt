package io.github.steve02081504.fountp2p.utils

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/** 等价 `test/pure/inflight_table.test.mjs`。 */
class InflightTableTest {
	@Test
	fun `inflight acquire reuses same done and touches to tail`() = runBlocking {
		var starts = 0
		var settle: ((String?) -> Unit)? = null
		val table = InflightTable<String?>(8, ms("1s"))

		val first = table.acquire("a") {
			starts++
			val done = CompletableDeferred<String?>()
			settle = { value -> done.complete(value) }
			Started(done) { done.complete(null) }
		}
		val second = table.acquire("a") {
			starts++
			throw AssertionError("must not start again")
		}
		assertEquals(1, starts)
		assertSame(first, second)
		assertEquals(1, table.size())

		settle!!("ok")
		assertEquals("ok", first!!.await())
		assertEquals("ok", second!!.await())
		yield()
		assertEquals(0, table.size())
	}

	@Test
	fun `inflight refuses new key when full and front is still within baseTimeout`() {
		val clock = 1000L
		val table = InflightTable<String?>(2, 500, now = { clock })
		val cancels = mutableListOf<() -> Unit>()

		fun start(key: String): Deferred<String?>? = table.acquire(key) {
			var settled = false
			val done = CompletableDeferred<String?>()
			val cancel = {
				if (!settled) {
					settled = true
					done.complete(null)
				}
			}
			cancels.add(cancel)
			Started(done, cancel)
		}

		assertEquals(true, start("a") != null)
		assertEquals(true, start("b") != null)
		assertEquals(2, table.size())
		assertNull(start("c"))
		assertEquals(2, cancels.size)
	}

	@Test
	fun `inflight cancels aged front only when over cap (dual window)`() {
		var clock = 0L
		val table = InflightTable<String?>(2, 100, now = { clock })
		val cancelled = mutableListOf<String>()

		fun start(key: String): Deferred<String?>? = table.acquire(key) {
			val done = CompletableDeferred<String?>()
			Started(done) {
				cancelled.add(key)
				done.complete(null)
			}
		}

		assertEquals(true, start("old") != null)
		clock = 50
		assertEquals(true, start("mid") != null)
		clock = 150
		// old aged (>=100) and at front; admitting 'new' needs a slot → cancel old
		val newest = start("new")
		assertEquals(true, newest != null)
		assertEquals(listOf("old"), cancelled)
		assertEquals(false, table.has("old"))
		assertEquals(true, table.has("mid"))
		assertEquals(true, table.has("new"))
		assertEquals(2, table.size())

		table.clear()
	}

	@Test
	fun `reuse touches key so a fresher sibling is cancelled first under pressure`() {
		var clock = 0L
		val table = InflightTable<String?>(2, 10, now = { clock })
		val cancelled = mutableListOf<String>()

		fun start(key: String): Deferred<String?>? = table.acquire(key) {
			val done = CompletableDeferred<String?>()
			Started(done) {
				cancelled.add(key)
				done.complete(null)
			}
		}

		start("a")
		clock = 1
		start("b")
		clock = 2
		// touch a → order becomes b, a
		start("a")
		clock = 100
		start("c")
		assertEquals(listOf("b"), cancelled)
		assertEquals(true, table.has("a"))
		assertEquals(true, table.has("c"))
		table.clear()
	}
}
