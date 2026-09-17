package io.github.steve02081504.fountp2p.infra

import io.github.steve02081504.fountp2p.deleteRecursively
import io.github.steve02081504.fountp2p.node.NodeInitOptions
import io.github.steve02081504.fountp2p.node.closeNode
import io.github.steve02081504.fountp2p.node.initNode
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Paths

/** infra 门面（default_node_dir / priority / service 守卫）。 */
class InfraTest {
	@Test
	fun `defaultNodeDir ends with fount-p2p node`() {
		val dir = defaultNodeDir()
		assertTrue(dir.endsWith(Paths.get("fount-p2p", "node").toString()))
	}

	@Test
	fun `resolveNodeDir resolves override and falls back to default`() {
		val resolved = resolveNodeDir("some/relative/dir")
		assertEquals(Paths.get("some/relative/dir").toAbsolutePath().normalize().toString(), resolved)
		assertEquals(defaultNodeDir(), resolveNodeDir(null))
		assertEquals(defaultNodeDir(), resolveNodeDir(""))
	}

	@Test
	fun `infra not running by default and stopInfra is a no-op`() {
		assertFalse(isInfraRunning())
		runBlocking { stopInfra() }
		assertFalse(isInfraRunning())
	}

	@Test
	fun `priority config roundtrip and reset`() {
		val dir = Files.createTempDirectory("p2p-infra-")
		try {
			initNode(NodeInitOptions(nodeDir = dir.toString()))
			try {
				assertEquals(false, getInfraPriority()["useLocalReputation"])
				setInfraPriority(mapOf("useLocalReputation" to true))
				assertEquals(true, getInfraPriority()["useLocalReputation"])
				clearInfraPriorityFromRegistry()
				assertEquals(false, getInfraPriority()["useLocalReputation"])
			}
			finally {
				runBlocking { closeNode() }
			}
		}
		finally {
			deleteRecursively(dir)
		}
	}
}
