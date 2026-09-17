package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.discovery.bt.BluetoothRuntime
import io.github.steve02081504.fountp2p.discovery.bt.canUseBluetoothRuntime
import io.github.steve02081504.fountp2p.discovery.bt.probeBluetoothHardware
import io.github.steve02081504.fountp2p.discovery.bt.waitPoweredOn
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/bt_runtime_gate.test.mjs` + `test/pure/bt_wait_powered_on.test.mjs`。 */
class BtRuntimeTest {
	@Test
	fun `probeBluetoothHardware is boolean or null`() {
		val hint = probeBluetoothHardware()
		assertTrue(hint == true || hint == false || hint == null)
	}

	@Test
	fun `canUseBluetoothRuntime returns boolean without throwing`() = runBlocking {
		val ok = canUseBluetoothRuntime(500)
		assertEquals(java.lang.Boolean::class.javaObjectType, java.lang.Boolean.valueOf(ok).javaClass)
		assertEquals(ok, canUseBluetoothRuntime(500))
	}

	@Test
	fun `no adapter hint makes canUseBluetoothRuntime false`() = runBlocking {
		if (probeBluetoothHardware() !== false) return@runBlocking
		assertEquals(false, canUseBluetoothRuntime(500))
	}

	@Test
	fun `waitPoweredOn prefers waitForPoweredOnAsync`() = runBlocking {
		var called = ""
		val runtime = BluetoothRuntime(
			waitForPoweredOnAsync = { timeout -> called = "async:$timeout" },
			waitForPoweredOn = { called = "sync" },
		)
		waitPoweredOn(runtime, 5_000)
		assertEquals("async:5000", called)
	}

	@Test
	fun `waitPoweredOn falls back to waitForPoweredOn`() = runBlocking {
		var called = ""
		val runtime = BluetoothRuntime(
			waitForPoweredOn = { timeout -> called = "sync:$timeout" },
		)
		waitPoweredOn(runtime, 3_000)
		assertEquals("sync:3000", called)
	}

	@Test
	fun `waitPoweredOn throws when no powered on API`() = runBlocking {
		try {
			waitPoweredOn(BluetoothRuntime())
			throw AssertionError("expected throw")
		}
		catch (error: IllegalArgumentException) {
			assertTrue(
				error.message == "p2p: bluetooth runtime missing waitForPoweredOn(Async)",
			)
		}
	}
}
