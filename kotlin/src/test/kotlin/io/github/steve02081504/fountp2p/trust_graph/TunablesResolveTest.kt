package io.github.steve02081504.fountp2p.trust_graph

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/tunables_resolve.test.mjs`（trust_graph/resolve.mjs 部分）。
 *
 * 该 JS 测试还从 `dag/tunables.json` 与 `mailbox/tunables.json` 取归档/邮箱 tunables；
 * 这两个模块尚未移植，故这里把其 JSON 值内联为等价的 Map，仍按原断言完整覆盖
 * `scaleCount` / archive / mailbox / federation 全部函数。
 */
class TunablesResolveTest {
	private val archiveTunables: Map<String, Any?> = mapOf(
		"archiveQuorumPeerMinFloor" to 2.0,
		"archiveQuorumPeerMinRatio" to 0.25,
		"archiveQuorumPeerStrictMinFloor" to 2.0,
		"archiveQuorumPeerStrictMinRatio" to 0.5,
	)

	private val mailboxTunables: Map<String, Any?> = mapOf(
		"relayFanoutTrustedFloor" to 3.0,
		"relayFanoutTrustedRatio" to 0.3,
		"relayFanoutTrustedCap" to 32.0,
		"wantFanoutFloor" to 3.0,
		"wantFanoutRatio" to 0.4,
		"wantFanoutCap" to 32.0,
	)

	@Test
	fun `scaleCount respects floor ratio cap and n`() {
		assertEquals(2, scaleCount(0, ScaleSpec(2.0, 0.5)))
		assertEquals(2, scaleCount(8, ScaleSpec(2.0, 0.25)))
		assertEquals(4, scaleCount(8, ScaleSpec(2.0, 0.5)))
		assertEquals(16, scaleCount(40, ScaleSpec(2.0, 0.5, 16.0)))
		assertEquals(2, scaleCount(3, ScaleSpec(2.0, 0.5)))
	}

	@Test
	fun `archive quorum scales with n at reference 8`() {
		assertEquals(2, resolveArchiveQuorumPeerMin(8, archiveTunables))
		assertEquals(4, resolveArchiveQuorumPeerStrictMin(8, archiveTunables))
		assertEquals(2, resolveArchiveQuorumPeerMin(2, archiveTunables))
		assertEquals(2, resolveArchiveQuorumPeerStrictMin(2, archiveTunables))
	}

	@Test
	fun `mailbox fanout scales and caps`() {
		assertEquals(3, resolveMailboxRelayFanout(8, mailboxTunables))
		assertEquals(4, resolveMailboxWantFanout(8, mailboxTunables))
		assertEquals(30, resolveMailboxRelayFanout(100, mailboxTunables))
		assertEquals(32, resolveMailboxWantFanout(100, mailboxTunables))
	}

	@Test
	fun `federation fanout topK scales and caps`() {
		assertEquals(3, resolveFederationFanoutTopK(8, TrustGraphTunables.map))
		assertEquals(14, resolveFederationFanoutTopK(40, TrustGraphTunables.map))
		assertEquals(16, resolveFederationFanoutTopK(100, TrustGraphTunables.map))
	}

	@Test
	fun `resolveArchiveQuorumThresholds uses max of member and candidate counts`() {
		val t = resolveArchiveQuorumThresholds(archiveTunables, 3, 8)
		assertEquals(2, t.peerMin)
		assertEquals(4, t.strictMin)
	}
}
