package io.github.steve02081504.fountp2p.transport

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/mesh_pool.test.mjs`。
 */
class MeshPoolTest {
	private val self = "a".repeat(64)
	private val t1 = "1".repeat(64)
	private val t2 = "2".repeat(64)
	private val e1 = "e".repeat(64)
	private val e2 = "f".repeat(64)
	private val e3 = "3".repeat(64)
	private val blocked = "b".repeat(64)
	private val quar = "c".repeat(64)

	private val tunables: Map<String, Any?> = mapOf(
		"meshN" to 8.0,
		"meshKMax" to 5.0,
		"meshNLow" to 4.0,
		"meshKMaxLow" to 2.0,
	)

	@Test
	fun `resolveMeshPoolLimits default vs low profile`() {
		assertEquals(MeshPoolLimits(8, 5), resolveMeshPoolLimits("default", tunables))
		assertEquals(MeshPoolLimits(4, 2), resolveMeshPoolLimits("low", tunables))
	}

	@Test
	fun `selectMeshLinkTargets K=0 fills explore only`() {
		val limits = MeshPoolLimits(4, 0)
		val targets = selectMeshLinkTargets(
			selfNodeHash = self,
			trustedPeers = listOf(t1),
			exploreCandidates = listOf(e1, e2, e3),
			limits = limits,
			connectedHashes = emptySet(),
			rep = mapOf("byNodeHash" to emptyMap<String, Any?>()),
			blockedPeers = emptyList(),
		)
		assertEquals(false, targets.contains(t1))
		assertEquals(3, targets.size)
	}

	@Test
	fun `selectMeshLinkTargets trusted first then explore quota`() {
		val limits = MeshPoolLimits(3, 2)
		val rep: Map<String, Any?> = mapOf(
			"byNodeHash" to mapOf<String, Any?>(
				t1 to mapOf<String, Any?>("score" to 0.9),
				t2 to mapOf<String, Any?>("score" to 0.8),
				e1 to mapOf<String, Any?>("score" to 0.1),
				e2 to mapOf<String, Any?>("score" to 0.05),
			),
		)
		val targets = selectMeshLinkTargets(
			selfNodeHash = self,
			trustedPeers = listOf(t1, t2),
			exploreCandidates = listOf(e1, e2),
			limits = limits,
			connectedHashes = emptySet(),
			rep = rep,
			blockedPeers = listOf(blocked),
		)
		assertEquals(listOf(t1, t2), targets.subList(0, 2))
		assertEquals(3, targets.size)
		assertEquals(true, targets.toSet().contains(e1) || targets.toSet().contains(e2))
	}

	@Test
	fun `selectMeshLinkTargets filters blocked and quarantined`() {
		val limits = MeshPoolLimits(4, 0)
		val targets = selectMeshLinkTargets(
			selfNodeHash = self,
			trustedPeers = emptyList(),
			exploreCandidates = listOf(e1, blocked, quar),
			limits = limits,
			connectedHashes = emptySet(),
			rep = mapOf(
				"byNodeHash" to mapOf<String, Any?>(
					quar to mapOf<String, Any?>("score" to 0.99, "quarantinedUntil" to System.currentTimeMillis().toDouble() + 1_000_000),
				),
			),
			blockedPeers = listOf(blocked),
		)
		assertEquals(listOf(e1), targets)
	}

	@Test
	fun `selectMeshLinkTargets when K trusted already connected fill remaining with explore`() {
		val limits = MeshPoolLimits(8, 5)
		val connectedTrusted = listOf(t1, t2, "4".repeat(64), "5".repeat(64), "6".repeat(64))
		val moreTrusted = listOf("7".repeat(64), "8".repeat(64), "9".repeat(64))
		val targets = selectMeshLinkTargets(
			selfNodeHash = self,
			trustedPeers = connectedTrusted + moreTrusted,
			exploreCandidates = listOf(e1, e2, e3),
			limits = limits,
			connectedHashes = connectedTrusted.toSet(),
			rep = mapOf("byNodeHash" to emptyMap<String, Any?>()),
			blockedPeers = emptyList(),
		)
		assertEquals(3, targets.size)
		assertEquals(true, targets.all { listOf(e1, e2, e3).contains(it) })
		assertEquals(false, targets.any { moreTrusted.contains(it) })
	}

	@Test
	fun `selectMeshLinkTargets when N explore connected still dial trusted for rebalance`() {
		val limits = MeshPoolLimits(4, 2)
		val exploreConnected = listOf(e1, e2, e3, "d".repeat(64))
		val targets = selectMeshLinkTargets(
			selfNodeHash = self,
			trustedPeers = listOf(t1, t2),
			exploreCandidates = exploreConnected,
			limits = limits,
			connectedHashes = exploreConnected.toSet(),
			rep = mapOf(
				"byNodeHash" to mapOf<String, Any?>(
					t1 to mapOf<String, Any?>("score" to 0.9),
					t2 to mapOf<String, Any?>("score" to 0.8),
				),
			),
			blockedPeers = emptyList(),
		)
		assertEquals(listOf(t1, t2), targets)
	}

	@Test
	fun `selectMeshLinkTargets explore quota respects N-K when under capacity`() {
		val limits = MeshPoolLimits(4, 2)
		val targets = selectMeshLinkTargets(
			selfNodeHash = self,
			trustedPeers = listOf(t1, t2),
			exploreCandidates = listOf(e1, e2, e3),
			limits = limits,
			connectedHashes = setOf(t1, t2),
			rep = mapOf("byNodeHash" to emptyMap<String, Any?>()),
			blockedPeers = emptyList(),
		)
		assertEquals(2, targets.size)
		assertEquals(true, targets.all { listOf(e1, e2, e3).contains(it) })
	}

	@Test
	fun `pickMeshEvictionVictim explore link evicted before trusted`() {
		val explore = setOf(e1)
		val victim = pickMeshEvictionVictim(listOf(t1, e1), explore, listOf(t1)) { 0.0 }
		assertEquals(e1, victim)
	}

	@Test
	fun `pickMeshEvictionVictim lower scope weight among trusted`() {
		val victim = pickMeshEvictionVictim(listOf(t1, t2), emptySet(), listOf(t1, t2)) { hash -> if (hash == t1) 2.0 else 1.0 }
		assertEquals(t2, victim)
	}
}
