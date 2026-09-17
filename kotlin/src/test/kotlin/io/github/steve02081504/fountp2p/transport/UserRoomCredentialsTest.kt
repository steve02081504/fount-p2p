package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.sha256
import io.github.steve02081504.fountp2p.deleteRecursively
import io.github.steve02081504.fountp2p.node.NodeInitOptions
import io.github.steve02081504.fountp2p.node.closeNode
import io.github.steve02081504.fountp2p.node.initNode
import io.github.steve02081504.fountp2p.node.nodeHashFromSeed
import io.github.steve02081504.fountp2p.node.setP2PFeatures
import kotlinx.coroutines.runBlocking
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `js/test/integration/user_room_credentials.test.mjs`。
 */
class UserRoomCredentialsTest {
	@Test
	fun `resolveUserRoomCredentials derives deterministic room secret`() = runBlocking {
		val dir = Files.createTempDirectory("fount-user-room-")
		try {
			val seedHex = "07".repeat(32)
			Files.writeString(dir.resolve("node.json"), """{"nodeSeedHex":"$seedHex"}""")
			closeNode()
			initNode(NodeInitOptions(nodeDir = dir.toString()))
			setP2PFeatures(mapOf("census" to false))
			val nodeHash = nodeHashFromSeed(seedHex)
			val creds = resolveUserRoomCredentials()
			val expected = bytesToHex(sha256("fount-user-room:$nodeHash"))
			assertEquals(expected, creds["password"])
			assertEquals("fount-node-$nodeHash", creds["roomId"])
			assertEquals(nodeHash, creds["nodeHash"])
			assertEquals("fount-user-fed", creds["appId"])
		}
		finally {
			closeNode()
			deleteRecursively(dir)
		}
	}
}
