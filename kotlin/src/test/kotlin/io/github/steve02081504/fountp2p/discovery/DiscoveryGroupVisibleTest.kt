package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.discovery.nostr.clearNostrVisibleNodes
import io.github.steve02081504.fountp2p.discovery.nostr.createNostrDiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.nostr.listNostrGroupVisibleNodeHashes
import io.github.steve02081504.fountp2p.discovery.nostr.listNostrVisibleNodeHashes
import io.github.steve02081504.fountp2p.discovery.nostr.noteNostrGroupVisibleNode
import io.github.steve02081504.fountp2p.discovery.nostr.noteNostrVisibleNode
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/discovery_group_visible.test.mjs`。 */
class DiscoveryGroupVisibleTest {
	private val net = "a".repeat(64)
	private val groupA = "b".repeat(64)
	private val groupB = "c".repeat(64)
	private val room = "room-secret-1"

	@Test
	fun `nostr network and group visible pools are isolated`() {
		clearNostrVisibleNodes()
		noteNostrVisibleNode(net)
		noteNostrGroupVisibleNode(room, groupA)
		assertEquals(true, listNostrVisibleNodeHashes().contains(net))
		assertEquals(false, listNostrVisibleNodeHashes().contains(groupA))
		assertEquals(listOf(groupA), listNostrGroupVisibleNodeHashes(room))
		assertEquals(emptyList<String>(), listNostrGroupVisibleNodeHashes("other"))
		clearNostrVisibleNodes()
	}

	@Test
	fun `listVisible with roomSecret does not leak network or LAN peers`() = runBlocking {
		clearDiscoveryProviders()
		clearNostrVisibleNodes()
		clearLanVisibleNodes()
		noteNostrVisibleNode(net)
		noteNostrGroupVisibleNode(room, groupA)
		noteLanVisibleNode(groupB)
		registerDiscoveryProvider(createNostrDiscoveryProvider(mapOf("relayUrls" to emptyList<String>())))
		registerDiscoveryProvider(createLanDiscoveryProvider())
		assertEquals(setOf(net, groupB), listVisibleNodeHashes(mapOf("limit" to 64)).toSet())
		assertEquals(listOf(groupA), listVisibleNodeHashes(mapOf("roomSecret" to room, "limit" to 64)))
		clearDiscoveryProviders()
		clearNostrVisibleNodes()
		clearLanVisibleNodes()
	}

	@Test
	fun `mock publishGroupAdvert fills group visible list`() = runBlocking {
		clearDiscoveryProviders()
		val mock = MockDiscoveryProvider()
		registerDiscoveryProvider(mock)
		mock.publishAdvert(net, byteArrayOf(1))
		mock.publishGroupAdvert(room, groupA, byteArrayOf(2))
		assertEquals(listOf(net), listVisibleNodeHashes(mapOf("limit" to 8)))
		assertEquals(listOf(groupA), listVisibleNodeHashes(mapOf("roomSecret" to room, "limit" to 8)))
		clearDiscoveryProviders()
	}

	private class MockDiscoveryProvider : DiscoveryProvider("mock-discovery", 1.0) {
		private val visible = LinkedHashSet<String>()
		private val visibleByGroup = LinkedHashMap<String, LinkedHashSet<String>>()

		fun publishAdvert(nodeHash: String, bytes: ByteArray) {
			visible.add(nodeHash)
		}

		fun publishGroupAdvert(roomSecret: String, nodeHash: String, bytes: ByteArray) {
			visibleByGroup.getOrPut(roomSecret) { LinkedHashSet() }.add(nodeHash)
		}

		override suspend fun listVisibleNodeHashes(options: Map<String, Any?>): List<String> {
			val limit = maxOf(1, (options["limit"] as? Number)?.toInt() ?: 64)
			val roomSecret = options["roomSecret"]?.toString()
			if (!roomSecret.isNullOrEmpty()) return (visibleByGroup[roomSecret] ?: emptySet<String>()).take(limit)
			return visible.take(limit)
		}

		override suspend fun connectToNode(nodeHash: String, options: Map<String, Any?>): Boolean = visible.contains(nodeHash)
	}
}
