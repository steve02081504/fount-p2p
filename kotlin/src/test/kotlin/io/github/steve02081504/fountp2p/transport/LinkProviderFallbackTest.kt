package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.TestIdentity
import io.github.steve02081504.fountp2p.discovery.noteDiscoveryPeerClue
import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.link.providers.clearLinkProviders
import io.github.steve02081504.fountp2p.link.providers.registerLinkProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * 等价 `js/test/pure/link_provider_fallback.test.mjs`。
 *
 * 偏离：用假 bootstrap 替代真实暖机、并关闭 mesh keepalive，避免测试触碰 node 目录/网络。
 */
class LinkProviderFallbackTest {
	private fun localIdentityMap(identity: TestIdentity): Map<String, Any?> = linkedMapOf(
		"nodeHash" to identity.nodeHash,
		"nodePubKey" to identity.nodePubKey,
		"secretKey" to identity.secretKey,
	)

	@Before
	fun setUp() {
		clearLinkProviders()
	}

	@After
	fun tearDown() {
		clearLinkProviders()
	}

	private fun registry(identity: TestIdentity): LinkRegistry =
		createLinkRegistry(
			LinkRegistryOptions(
				localIdentity = localIdentityMap(identity),
				meshKeepalive = false,
				autoRegisterDiscoveryProviders = false,
				autoRegisterLinkProviders = false,
			),
		) { FakeRuntimeBootstrap() }

	@Test
	fun `ensureLinkToNode falls back by level when higher provider fails`() = runBlocking {
		clearLinkProviders()
		val dialed = ArrayList<String>()
		registerLinkProvider(
			MockLinkProvider(
				id = "high-fail",
				level = 90.0,
				dialImpl = { dialed.add("high-fail"); throw IllegalStateException("simulated failure") },
			),
		)
		registerLinkProvider(
			MockLinkProvider(
				id = "low-ok",
				level = 40.0,
				dialImpl = { options ->
					dialed.add("low-ok")
					MockLinkHandle(options["nodeHash"]?.toString(), true, 40.0, "low-ok")
				},
			),
		)
		val alice = identity(21)
		val bob = identity(22)
		val registry = registry(alice)
		try {
			registry.ensureRuntime()
			val link = registry.ensureLinkToNode(bob.nodeHash)
			assertEquals(listOf("high-fail", "low-ok"), dialed)
			assertEquals("low-ok", link?.providerId)
			assertEquals(40.0, link?.level)
		}
		finally {
			registry.shutdown()
			clearLinkProviders()
		}
	}

	@Test
	fun `canReach false skips dial entirely`() = runBlocking {
		clearLinkProviders()
		val dialed = ArrayList<String>()
		registerLinkProvider(
			MockLinkProvider(
				id = "unreachable",
				level = 90.0,
				dialImpl = { dialed.add("unreachable"); throw IllegalStateException("should not dial") },
				canReachValue = false,
			),
		)
		registerLinkProvider(
			MockLinkProvider(
				id = "reachable",
				level = 40.0,
				dialImpl = { options ->
					dialed.add("reachable")
					MockLinkHandle(options["nodeHash"]?.toString(), true, 40.0, "reachable")
				},
			),
		)
		val registry = registry(identity(27))
		try {
			registry.ensureRuntime()
			val link = registry.ensureLinkToNode(identity(28).nodeHash)
			assertEquals(listOf("reachable"), dialed)
			assertEquals("reachable", link?.providerId)
		}
		finally {
			registry.shutdown()
			clearLinkProviders()
		}
	}

	@Test
	fun `needsOfferAnswer soft-fail continues to lower level`() = runBlocking {
		clearLinkProviders()
		val dialed = ArrayList<String>()
		registerLinkProvider(
			MockLinkProvider(
				id = "offer-soft",
				level = 70.0,
				dialImpl = { dialed.add("offer-soft"); null },
				caps = mapOf("needsOfferAnswer" to true),
			),
		)
		registerLinkProvider(
			MockLinkProvider(
				id = "ble-ok",
				level = 40.0,
				dialImpl = { options ->
					dialed.add("ble-ok")
					MockLinkHandle(options["nodeHash"]?.toString(), true, 40.0, "ble-ok")
				},
			),
		)
		val registry = registry(identity(25))
		try {
			registry.ensureRuntime()
			val link = registry.ensureLinkToNode(identity(26).nodeHash)
			assertEquals(listOf("offer-soft", "ble-ok"), dialed)
			assertEquals("ble-ok", link?.providerId)
			assertEquals(40.0, link?.level)
		}
		finally {
			registry.shutdown()
			clearLinkProviders()
		}
	}

	@Test
	fun `inbound higher level replaces lower canonical link`() = runBlocking {
		clearLinkProviders()
		val alice = identity(23)
		val bob = identity(24)
		val lowLink = MockLinkHandle(bob.nodeHash, initiator = true, level = 40.0, providerId = "low")
		registerLinkProvider(MockLinkProvider(id = "low", level = 40.0, dialImpl = { lowLink }))
		val registry = registry(alice)
		try {
			registry.ensureRuntime()
			val first = registry.ensureLinkToNode(bob.nodeHash)
			assertEquals("low", first?.providerId)

			val highLink = MockLinkHandle(bob.nodeHash, initiator = false, level = 90.0, providerId = "inbound-high")
			registry.registerResolvedLink(bob.nodeHash, highLink)

			val canonical = registry.getLink(bob.nodeHash)
			assertEquals("inbound-high", canonical?.providerId)
			assertEquals(90.0, canonical?.level)
			assertEquals("provider-replaced", lowLink.closedReason)
		}
		finally {
			registry.shutdown()
			clearLinkProviders()
		}
	}

	@Test
	fun `ensureLinkToNode cools down after dial exhausted`() = runBlocking {
		clearLinkProviders()
		var dials = 0
		registerLinkProvider(
			MockLinkProvider(
				id = "always-miss",
				level = 50.0,
				dialImpl = { dials++; null },
			),
		)
		val registry = registry(identity(61))
		try {
			registry.ensureRuntime()
			assertEquals(null, registry.ensureLinkToNode(identity(62).nodeHash))
			assertEquals(1, dials)
			assertEquals(null, registry.ensureLinkToNode(identity(62).nodeHash))
			assertEquals(1, dials)
		}
		finally {
			registry.shutdown()
			clearLinkProviders()
		}
	}

	@Test
	fun `ensureLinkToNode clears cooldown on discovery peer clue`() = runBlocking {
		clearLinkProviders()
		var dials = 0
		registerLinkProvider(
			MockLinkProvider(
				id = "always-miss",
				level = 50.0,
				dialImpl = { dials++; null },
			),
		)
		val bob = identity(64)
		val registry = registry(identity(63))
		try {
			registry.ensureRuntime()
			assertEquals(null, registry.ensureLinkToNode(bob.nodeHash))
			assertEquals(1, dials)
			noteDiscoveryPeerClue(bob.nodeHash)
			assertEquals(null, registry.ensureLinkToNode(bob.nodeHash))
			assertEquals(2, dials)
		}
		finally {
			registry.shutdown()
			clearLinkProviders()
		}
	}
}
