package io.github.steve02081504.fountp2p.trust_graph

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/trust_graph_registry.test.mjs`。 */
class RegistryTest {
	private val testUser = "__p2p_trust_graph_test__"

	@Test
	fun `trust graph registry register and require`() = runBlocking {
		clearTrustGraphProvider()
		val error = try {
			requireTrustGraphProvider("test")
			null
		}
		catch (e: IllegalStateException) {
			e
		}
		assertNotNull(error)
		assertTrue(error!!.message!!.contains("registerTrustGraphProvider"))

		val provider = object : TrustGraphProvider {
			override suspend fun buildMergedGraph(username: String): Map<String, TrustNode> = emptyMap()

			override suspend fun pickTopNodes(username: String, limit: Int): List<TrustNode> = emptyList()

			override suspend fun sendToNode(
				username: String,
				targetNodeHash: String,
				actionName: String,
				payload: Any?,
				graph: Map<String, TrustNode>?,
			): Boolean = false

			override suspend fun fanoutToTopNodes(
				username: String,
				actionName: String,
				payload: Any?,
				limit: Int?,
			): Int = 0
		}
		registerTrustGraphProvider("test", provider)
		assertEquals(
			0,
			requireTrustGraphProvider("test").fanoutToTopNodes(testUser, "part_invoke", emptyMap<String, Any?>(), 1),
		)
		clearTrustGraphProvider()
	}

	@Test
	fun `default owner id is not chat`() {
		assertEquals("default", DEFAULT_TRUST_GRAPH_OWNER)
	}
}
