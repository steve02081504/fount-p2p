package io.github.steve02081504.fountp2p.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * 等价 `test/pure/p2p_features.test.mjs`。
 */
class P2PFeaturesTest {
	@Test
	fun `default features census on by default`() {
		assertEquals(mapOf("census" to true), defaultP2PFeatures())
	}

	@Test
	fun `resolveP2PFeatures keeps unknown boolean flags through`() {
		assertEquals(
			linkedMapOf<String, Any?>("census" to true, "foo" to true, "bar" to false),
			resolveP2PFeatures(mapOf("foo" to true, "bar" to false)),
		)
	}

	@Test
	fun `resolveP2PFeatures overrides known default`() {
		assertEquals(mapOf<String, Any?>("census" to false), resolveP2PFeatures(mapOf("census" to false)))
	}

	@Test
	fun `resolveP2PFeatures returns full snapshot copy`() {
		val patch = linkedMapOf<String, Any?>("census" to true)
		val resolved = resolveP2PFeatures(patch)
		@Suppress("UNCHECKED_CAST")
		(resolved as MutableMap<String, Any?>)["census"] = false
		assertEquals(mapOf<String, Any?>("census" to false), resolved)
		assertEquals(mapOf<String, Any?>("census" to true), patch)
		assertEquals(mapOf<String, Any?>("census" to true), defaultP2PFeatures())
	}

	@Test
	fun `resolveP2PFeatures rejects non-boolean values`() {
		assertThrows(IllegalArgumentException::class.java) { resolveP2PFeatures(mapOf("census" to "yes")) }
		assertThrows(IllegalArgumentException::class.java) { resolveP2PFeatures(mapOf("census" to 1.0)) }
		assertThrows(IllegalArgumentException::class.java) { resolveP2PFeatures(mapOf("census" to null)) }
	}

	@Test
	fun `resolveP2PFeatures tolerates undefined patch`() {
		assertEquals(mapOf("census" to true), resolveP2PFeatures())
	}
}
