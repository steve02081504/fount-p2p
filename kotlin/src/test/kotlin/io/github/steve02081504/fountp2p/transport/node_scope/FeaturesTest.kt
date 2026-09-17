package io.github.steve02081504.fountp2p.transport.node_scope

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** `transport/node_scope/features.mjs` 的等价测试。 */
class FeaturesTest {
	private val builtinActions = listOf(
		"part_invoke",
		"part_invoke_response",
		"part_timeline_put",
		"part_query_req",
		"part_query_res",
		"mailbox_put",
		"mailbox_want",
		"mailbox_give",
		"fed_chunk_get",
		"fed_chunk_data",
		"fed_manifest_get",
		"fed_manifest_data",
	)

	@After
	fun cleanup() {
		stopNodeScopeRuntime()
		configureNodeScopeLinkBridge(NoopNodeScopeLinkBridge)
	}

	@Test
	fun `attachNodeScopeDefaultFeatures mounts part partQuery mailbox and chunks`() {
		attachNodeScopeDefaultFeatures(mapOf("replicaUsername" to "alice"))

		for (action in builtinActions) assertTrue("missing handler for $action", hasNodeScopeAction(action))
		assertEquals("alice", getNodeScopeContext().replicaUsername)
	}

	@Test
	fun `attachNodeScopeDefaultFeatures dispose unmounts every feature`() {
		val dispose = attachNodeScopeDefaultFeatures()
		dispose()

		for (action in builtinActions) assertFalse("stale handler for $action", hasNodeScopeAction(action))
	}

	@Test
	fun `attachNodeScopeMailbox is ref counted`() {
		val first = attachNodeScopeMailbox()
		val second = attachNodeScopeMailbox()
		assertEquals(1, countNodeScopeActionHandlers("mailbox_put"))

		first()
		assertEquals(1, countNodeScopeActionHandlers("mailbox_put"))

		second()
		assertEquals(0, countNodeScopeActionHandlers("mailbox_put"))
	}

	@Test
	fun `single feature attaches only its own actions`() {
		attachNodeScopeChunks()

		assertTrue(hasNodeScopeAction("fed_chunk_get"))
		assertTrue(hasNodeScopeAction("fed_manifest_data"))
		assertFalse(hasNodeScopeAction("mailbox_put"))
		assertFalse(hasNodeScopeAction("part_invoke"))
		assertFalse(hasNodeScopeAction("part_query_req"))
	}

	@Test
	fun `stopNodeScopeRuntime unmounts features and clears core`() {
		attachNodeScopeDefaultFeatures()
		assertNotNull(getNodeScopeWire())

		stopNodeScopeRuntime()

		assertFalse(hasNodeScopeAction("mailbox_put"))
		assertNull(getNodeScopeWire())
	}

	@Test
	fun `stopNodeScopeRuntime keepSubscribe keeps core wire`() {
		attachNodeScopeDefaultFeatures()

		stopNodeScopeRuntime(mapOf("keepSubscribe" to true))

		assertFalse(hasNodeScopeAction("mailbox_put"))
		assertNotNull(getNodeScopeWire())
	}

	@Test
	fun `stopNodeScopeRuntime is idempotent`() {
		attachNodeScopeDefaultFeatures()
		stopNodeScopeRuntime()
		stopNodeScopeRuntime()
		assertNull(getNodeScopeWire())
	}
}
