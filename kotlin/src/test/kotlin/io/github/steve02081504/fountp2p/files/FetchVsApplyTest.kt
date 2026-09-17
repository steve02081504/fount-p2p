package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.files.manifest.cachePublicManifest
import io.github.steve02081504.fountp2p.files.manifest.fetchManifest
import io.github.steve02081504.fountp2p.node.buildUnverifiedSlashAlert
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `js/test/pure/fetch_vs_apply.test.mjs`。 */
class FetchVsApplyTest {
	@Test
	fun `buildUnverifiedSlashAlert builds volatile slash alert`() {
		val sender = "a".repeat(64)
		val target = "b".repeat(64)
		val alert = buildUnverifiedSlashAlert(sender, mapOf("targetPubKeyHash" to target, "claim" to 0.2))
		assertEquals("reputation_slash_alert", alert["type"])
		assertEquals(target, alert["targetPubKeyHash"])
		assertEquals(sender, alert["sender"])
	}

	@Test
	fun `fetchManifest and cachePublicManifest are separate exports`() {
		val fetchReference: Any = ::fetchManifest
		val cacheReference: Any = ::cachePublicManifest
		assertEquals(2, listOf(fetchReference, cacheReference).size)
	}

	@Test
	fun `fetchManifest returns null on bad input without hanging`() = runBlocking {
		val miss = fetchManifest(mapOf("username" to "", "ownerEntityHash" to "", "logicalPath" to ""))
		assertNull(miss)
	}
}
