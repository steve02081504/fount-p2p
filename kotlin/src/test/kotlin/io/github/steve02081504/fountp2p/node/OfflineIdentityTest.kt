package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.FountP2p
import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.deleteRecursively
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.file.Files

/**
 * `configureNodeStorage` 离线身份：存储目录与节点运行时解耦。
 *
 * 等价 JS `test/integration/node_identity_offline.test.mjs`。
 */
class OfflineIdentityTest {
	@Test
	fun `configureNodeStorage enables local identity without initNode`() = runBlocking {
		val dir = Files.createTempDirectory("fount-offline-")
		try {
			closeNode()
			assertEquals(dir.toString(), configureNodeStorage(dir.toString()))
			assertEquals(dir.toString(), getNodeDir())
			assertEquals(false, isNodeInitialized())
			assertThrows(IllegalStateException::class.java) { getNode() }
			assertThrows(IllegalStateException::class.java) { getEntityStore() }

			val recovery = bytesToHex(keyPairFromSeed(randomBytes(32)).publicKey)
			val entityHash = resolveLocalEntityHashFromRecoveryPubKeyHex(recovery)
			assertEquals(128, entityHash!!.length)
			assertEquals(false, isNodeInitialized())
		}
		finally {
			closeNode()
			deleteRecursively(dir)
		}
	}

	@Test
	fun `seed persists across reconfigure and closeNode`() = runBlocking {
		val dir = Files.createTempDirectory("fount-offline-")
		try {
			closeNode()
			configureNodeStorage(dir.toString())
			val seed = ensureNodeSeed()
			assertEquals(64, seed.length)
			assertEquals(seed, ensureNodeSeed())

			configureNodeStorage(dir.toString())
			assertEquals(seed, ensureNodeSeed())

			closeNode()
			configureNodeStorage(dir.toString())
			assertEquals(seed, ensureNodeSeed())
		}
		finally {
			closeNode()
			deleteRecursively(dir)
		}
	}

	@Test
	fun `existing node json seed and extra fields are preserved`() = runBlocking {
		val dir = Files.createTempDirectory("fount-offline-")
		try {
			closeNode()
			configureNodeStorage(dir.toString())
			val seed = "a".repeat(64)
			writeNodeJsonSync("node", mapOf("nodeSeedHex" to seed, "customField" to "keep-me"))
			assertEquals(seed, ensureNodeSeed())
			assertEquals(nodeHashFromSeed(seed), getNodeHash())
			assertEquals("keep-me", Json.obj(readNodeJsonSync("node"))?.get("customField"))
		}
		finally {
			closeNode()
			deleteRecursively(dir)
		}
	}

	@Test
	fun `offline identity hashes survive a later initNode on the same dir`() = runBlocking {
		val dir = Files.createTempDirectory("fount-offline-")
		try {
			closeNode()
			configureNodeStorage(dir.toString())
			val recovery = bytesToHex(keyPairFromSeed(randomBytes(32)).publicKey)
			val offlineNodeHash = getNodeHash()
			val offlineEntityHash = resolveLocalEntityHashFromRecoveryPubKeyHex(recovery)

			initNode(NodeInitOptions(nodeDir = dir.toString()))
			assertEquals(true, isNodeInitialized())
			assertEquals(offlineNodeHash, getNodeHash())
			assertEquals(offlineEntityHash, resolveLocalEntityHashFromRecoveryPubKeyHex(recovery))
		}
		finally {
			closeNode()
			deleteRecursively(dir)
		}
	}

	@Test
	fun `switching dir is rejected while running and allowed after closeNode`() = runBlocking {
		val dirA = Files.createTempDirectory("fount-offline-a-")
		val dirB = Files.createTempDirectory("fount-offline-b-")
		try {
			closeNode()
			configureNodeStorage(dirA.toString())
			val seedA = ensureNodeSeed()
			initNode(NodeInitOptions(nodeDir = dirA.toString()))
			assertThrows(IllegalStateException::class.java) { configureNodeStorage(dirB.toString()) }
			assertThrows(IllegalStateException::class.java) { initNode(NodeInitOptions(nodeDir = dirB.toString())) }

			closeNode()
			configureNodeStorage(dirB.toString())
			val seedB = ensureNodeSeed()
			assertNotEquals(seedA, seedB)

			configureNodeStorage(dirA.toString())
			assertEquals(seedA, ensureNodeSeed())
		}
		finally {
			closeNode()
			deleteRecursively(dirA)
			deleteRecursively(dirB)
		}
	}

	@Test
	fun `unconfigured and invalid dir raise explicit errors`(): Unit = runBlocking {
		closeNode()
		assertThrows(IllegalStateException::class.java) { getNodeDir() }
		assertThrows(IllegalStateException::class.java) { ensureNodeSeed() }
		assertThrows(IllegalArgumentException::class.java) { configureNodeStorage(null) }
		assertThrows(IllegalArgumentException::class.java) { configureNodeStorage("") }
	}

	@Test
	fun `facade exposes configureNodeStorage`() = runBlocking {
		val dir = Files.createTempDirectory("fount-offline-")
		try {
			closeNode()
			FountP2p.configureNodeStorage(dir.toString())
			assertEquals(dir.toString(), FountP2p.getNodeDir())
			assertEquals(false, FountP2p.isNodeInitialized())
		}
		finally {
			closeNode()
			deleteRecursively(dir)
		}
	}
}
