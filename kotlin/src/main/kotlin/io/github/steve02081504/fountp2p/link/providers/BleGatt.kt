package io.github.steve02081504.fountp2p.link.providers

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.discovery.bt.canUseBluetoothRuntime
import io.github.steve02081504.fountp2p.discovery.bt.getBluetoothProvider
import io.github.steve02081504.fountp2p.discovery.bt.getBtPeerHint
import io.github.steve02081504.fountp2p.link.LinkPipe
import io.github.steve02081504.fountp2p.link.LinkPipeOptions
import io.github.steve02081504.fountp2p.link.asLinkHandle

/** BLE GATT 数据 service UUID。 */
const val BLE_DATA_SERVICE_UUID = "f017f017f017f017f017f017f017f019"

/** BLE GATT 数据 characteristic UUID。 */
const val BLE_DATA_CHAR_UUID = "f017f017f017f017f017f017f017f01a"

private const val BT_DEVICE_NAME = "fount-bt"

private class GattPipeOptions(
	val initiator: Boolean,
	val linkId: String,
	val nodeHash: String?,
	val localIdentity: Map<String, Any?>?,
	val write: suspend (ByteArray) -> Unit,
	val onNotify: ((ByteArray) -> Unit) -> (() -> Unit),
	val closeTransport: suspend () -> Unit,
)

/**
 * 在 GATT write/notify 上建立 pipe。
 * @param options 配置
 * @return 已启动握手的 link
 */
private suspend fun openGattPipe(options: GattPipeOptions): LinkHandle {
	val pipeOptions = LinkPipeOptions(
		providerId = "ble_gatt",
		level = LINK_LEVEL_BLE_GATT,
		initiator = options.initiator,
		nodeHash = options.nodeHash,
		localIdentity = options.localIdentity,
		sendControlText = { text -> options.write(text.toByteArray(Charsets.UTF_8)) },
		sendFrame = { _, frame -> options.write(frame) },
		closeTransport = options.closeTransport,
	)
	val pipe: LinkPipe = createLinkIdBoundPipe(pipeOptions, options.linkId)
	val stopNotify = options.onNotify { data -> pipe.handleInbound(data) }
	pipe.onDown {
		try {
			stopNotify()
		}
		catch (_: Exception) {
			// ignore
		}
	}
	if (options.initiator)
		options.write(buildLinkOpen(options.linkId, options.localIdentity?.get("nodeHash")?.toString() ?: "").toByteArray(Charsets.UTF_8))
	pipe.startHandshake()
	return asLinkHandle(pipe)
}

/**
 * 创建 ble_gatt LinkProvider。
 *
 * 相对 JS 的差异：BLE GATT 连接/notify 经宿主注入的 BluetoothProvider.connectGatt 提供；
 * 未注入时 dial 抛错。`ensureListening` 未实现 accept 路径（Android 端由宿主补齐）。
 * @return BLE GATT provider
 */
fun createBleGattLinkProvider(): LinkProvider {
	val instanceId = "ble_gatt:" + bytesToHex(randomBytes(4))

	return object : LinkProvider {
		override val id: String = instanceId
		override val level: Double = LINK_LEVEL_BLE_GATT
		override val caps: Map<String, Any?> = mapOf("needsOfferAnswer" to false, "needsDiscoverySignal" to false, "probe" to "native")

		override suspend fun isAvailable(): Boolean = canUseBluetoothRuntime()

		override fun canReach(remote: Map<String, Any?>): Boolean = getBtPeerHint(remote["nodeHash"]?.toString()) != null

		override suspend fun dial(options: Map<String, Any?>): LinkHandle? {
			val remoteNodeHash = options["nodeHash"]?.toString() ?: return null
			val hint = getBtPeerHint(remoteNodeHash) ?: throw IllegalStateException("p2p: ble_gatt no peer hint")
			val provider = getBluetoothProvider() ?: throw IllegalStateException("p2p: ble_gatt transport unavailable")
			val connection = provider.connectGatt(hint.peripheralId)
				?: throw IllegalStateException("p2p: ble_gatt transport unavailable")
			@Suppress("UNCHECKED_CAST")
			val localIdentity = (options["localIdentity"] as? Map<String, Any?>)
			return openGattPipe(
				GattPipeOptions(
					initiator = true,
					linkId = bytesToHex(randomBytes(32)),
					nodeHash = remoteNodeHash,
					localIdentity = localIdentity,
					write = { connection.write(it) },
					onNotify = { handler -> connection.onNotify(handler) },
					closeTransport = { connection.close() },
				),
			)
		}

		override suspend fun ensureListening(onInbound: (LinkHandle) -> Unit, localIdentity: Map<String, Any?>): () -> Unit = {}
	}
}
