package io.github.steve02081504.fountp2p.node

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class VerificationTest {
    private val aHash = "a".repeat(64)
    private val bHash = "b".repeat(64)
    private val cHash = "c".repeat(64)
    @Test fun authenticatedClaimAndReceipt() = runBlocking {
        lateinit var a: NetworkVerificationService
        lateinit var b: NetworkVerificationService
        a = createNetworkVerificationService(aHash, { peer, action, payload -> assertEquals(bHash, peer); b.receive(action, payload, aHash); true })
        b = createNetworkVerificationService(bHash, { peer, action, payload -> assertEquals(aHash, peer); a.receive(action, payload, bHash); true })
        val challenge = a.create()
        assertEquals("pending", a.get(challenge["challenge"] as String)?.get("status"))
        assertEquals(mapOf("status" to "verified", "nodeHash" to bHash), b.prove(challenge))
        a.receive("verification_claim", challenge, cHash)
        assertEquals(bHash, a.get(challenge["challenge"] as String)?.get("nodeHash"))
    }
    @Test fun secretDeadlineAndExpiry() = runBlocking {
        var now = 1000L
        val a = createNetworkVerificationService(aHash, { _, _, _ -> true }, { now })
        val challenge = a.create(100)
        a.receive("verification_claim", challenge + ("challenge" to cHash), bHash)
        a.receive("verification_claim", challenge + ("expiresAt" to 1101L), bHash)
        assertEquals("pending", a.get(challenge["challenge"] as String)?.get("status"))
        now = 1100
        a.receive("verification_claim", challenge, bHash)
        assertEquals("timeout", a.get(challenge["challenge"] as String)?.get("reason"))
    }
    @Test fun unreachableAndInvalid() = runBlocking {
        val a = createNetworkVerificationService(aHash, { _, _, _ -> false })
        val b = createNetworkVerificationService(bHash, { _, _, _ -> false })
        assertEquals("unreachable", b.prove(a.create())["reason"])
        assertEquals("invalid challenge", b.prove(mapOf("requesterNodeHash" to aHash, "challenge" to cHash, "expiresAt" to 0L))["reason"])
        try { a.create(0); fail() } catch (_: IllegalArgumentException) {}
    }
    @Test fun temporaryAttachmentsPreservePermanentChallenges() = runBlocking {
        val dir = Files.createTempDirectory("verification-")
        var permanent: (() -> Unit)? = null
        try {
            configureNodeStorage(dir.toString())
            permanent = attachNetworkVerification()
            val current = getNetworkVerificationService()
            val challenge = current.create()
            repeat(3) {
                val temporary = attachNetworkVerification()
                temporary()
                assertSame(current, getNetworkVerificationService())
                assertEquals("pending", current.get(challenge["challenge"] as String)?.get("status"))
                assertEquals("verified", proveNetworkVerification(current.create())["status"])
                assertSame(current, getNetworkVerificationService())
            }
        } finally {
            permanent?.invoke()
            closeNode()
            dir.toFile().deleteRecursively()
        }
    }
}
