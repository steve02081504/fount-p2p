package io.github.steve02081504.fountp2p.utils

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch

class AsyncMutexTest {
	@Test
	fun `withAsyncMutex releases its map entry when done`() = runBlocking {
		val key = "test:release:${System.nanoTime()}"
		val before = asyncMutexCount()
		withAsyncMutex(key) { }
		assertEquals(before, asyncMutexCount())
	}

	@Test
	fun `withAsyncMutex does not leak on exception`() = runBlocking {
		val key = "test:exception:${System.nanoTime()}"
		val before = asyncMutexCount()
		var threw = false
		try {
			withAsyncMutex(key) { throw IllegalStateException("boom") }
		}
		catch (_: IllegalStateException) {
			threw = true
		}
		assertTrue(threw)
		assertEquals(before, asyncMutexCount())
	}

	@Test
	fun `withAsyncMutex serializes concurrent callers on the same key`() = runBlocking {
		val key = "test:serialize:${System.nanoTime()}"
		val before = asyncMutexCount()
		val entered = CountDownLatch(1)
		val release = CountDownLatch(1)
		var active = 0
		var maxActive = 0
		val first = launch(Dispatchers.IO) {
			withAsyncMutex(key) {
				active++
				maxActive = maxOf(maxActive, active)
				entered.countDown()
				release.await()
				active--
			}
		}
		entered.await()
		val second = launch(Dispatchers.IO) {
			withAsyncMutex(key) {
				active++
				maxActive = maxOf(maxActive, active)
				active--
			}
		}
		delay(150)
		assertFalse(second.isCompleted)
		assertEquals(1, maxActive)
		release.countDown()
		first.join()
		second.join()
		assertEquals(1, maxActive)
		assertEquals(before, asyncMutexCount())
	}
}
