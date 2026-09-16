package io.github.steve02081504.fountp2p.utils

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/ttl_map.test.mjs`。 */
class TtlMapTest {
	@Test
	fun `ttl map evicts when over maxSize even without get`() {
		val map = TtlMap<Int>(60_000, 8)
		for (i in 0 until 20) map.set("k$i", i)
		assertEquals(true, map.size() <= 8)
		assertEquals(19, map.get("k19"))
		assertNull(map.get("k0"))
	}

	@Test
	fun `ttl map expires on get`() {
		val map = TtlMap<Int>(1000, 64)
		map.set("a", 1)
		val t0 = System.currentTimeMillis()
		assertEquals(1, map.get("a", t0))
		assertNull(map.get("a", t0 + 1001))
		assertEquals(0, map.size())
	}
}
