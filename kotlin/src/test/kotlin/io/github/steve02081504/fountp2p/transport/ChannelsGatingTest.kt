package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.node.disableAllChannels
import io.github.steve02081504.fountp2p.node.resolveSignalingRuntimeConfig
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `js/test/pure/channels_gating.test.mjs` 的纯逻辑子集
 * （`resolve merges channel config; disableAllChannels off except overrides`）。
 *
 * 其余 channels_gating 用例依赖真实 lan/nostr/bt provider 可用性，属 live 范畴，未移植。
 */
class ChannelsGatingTest {
	@Test
	fun `resolve merges channel config disableAllChannels off except overrides`() {
		val config = resolveSignalingRuntimeConfig(
			mapOf(
				"channels" to disableAllChannels(
					mapOf("nostr" to mapOf("relay" to listOf("wss://loopback/"))),
				),
			),
		)
		@Suppress("UNCHECKED_CAST")
		val channels = config["channels"] as Map<String, Any?>
		assertEquals(
			linkedMapOf<String, Any?>(
				"nostr" to mapOf<String, Any?>("relay" to listOf("wss://loopback/")),
				"lan" to false,
				"bt" to false,
				"webrtc" to false,
			),
			channels,
		)
	}
}
