package io.github.steve02081504.fountp2p.link.providers

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.discovery.getLanPeerHint
import io.github.steve02081504.fountp2p.discovery.listLanPeerHints
import io.github.steve02081504.fountp2p.link.LinkPipe
import io.github.steve02081504.fountp2p.link.LinkPipeOptions
import io.github.steve02081504.fountp2p.link.asLinkHandle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

private const val MAX_FRAME_BYTES = 1 shl 20

private val lanTcpScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/** TCP 连接抽象（Android/JVM 无 `node:net`；由宿主注入）。 */
interface TcpConnection {
	/** 入站数据回调。 */
	var onData: ((ByteArray) -> Unit)?

	/** 关闭回调。 */
	var onClose: (() -> Unit)?

	/** 错误回调。 */
	var onError: (() -> Unit)?

	/**
	 * @param bytes 出站字节
	 */
	fun write(bytes: ByteArray)

	/** 关闭连接。 */
	fun destroy()
}

/** TCP 监听句柄。 */
interface TcpServer {
	/** 监听端口。 */
	val port: Int

	/** 停止监听。 */
	fun close()
}

/** TCP 拨号/监听抽象。 */
interface TcpDialer {
	/**
	 * @param host 目标 host
	 * @param port 目标 port
	 * @return 已连接 socket
	 */
	suspend fun connect(host: String, port: Int): TcpConnection

	/**
	 * @param port 监听端口（0 表示随机）
	 * @param onConnection 入站连接回调
	 * @return 监听句柄
	 */
	suspend fun listen(port: Int, onConnection: (TcpConnection) -> Unit): TcpServer
}

private var tcpDialer: TcpDialer? = null

/** @param dialer TCP 拨号/监听实现 */
fun setTcpDialer(dialer: TcpDialer?) {
	tcpDialer = dialer
}

private fun writeUInt32BE(target: ByteArray, offset: Int, value: Int) {
	target[offset] = (value ushr 24).toByte()
	target[offset + 1] = (value ushr 16).toByte()
	target[offset + 2] = (value ushr 8).toByte()
	target[offset + 3] = value.toByte()
}

private fun readUInt32BE(source: ByteArray, offset: Int): Int =
	((source[offset].toInt() and 0xff) shl 24) or
		((source[offset + 1].toInt() and 0xff) shl 16) or
		((source[offset + 2].toInt() and 0xff) shl 8) or
		(source[offset + 3].toInt() and 0xff)

/** length-prefix（u32be + payload）编解码。 */
private class LengthPrefixCodec(private val connection: TcpConnection, private val onPayload: (ByteArray) -> Unit) {
	private var buffer = ByteArray(0)

	init {
		connection.onData = { chunk -> append(chunk) }
	}

	private fun append(chunk: ByteArray) {
		buffer += chunk
		while (buffer.size >= 4) {
			val length = readUInt32BE(buffer, 0)
			if (length > MAX_FRAME_BYTES) {
				connection.destroy()
				return
			}
			if (buffer.size - 4 < length) break
			val payload = buffer.copyOfRange(4, 4 + length)
			buffer = buffer.copyOfRange(4 + length, buffer.size)
			onPayload(payload)
		}
	}

	/**
	 * @param payload 出站载荷
	 */
	fun write(payload: ByteArray) {
		val out = ByteArray(4 + payload.size)
		writeUInt32BE(out, 0, payload.size)
		System.arraycopy(payload, 0, out, 4, payload.size)
		connection.write(out)
	}

	/** 仅移除 data 监听器。 */
	fun destroy() {
		connection.onData = null
	}
}

private class TcpPipeOptions(
	val initiator: Boolean,
	val linkId: String,
	val nodeHash: String?,
	val localIdentity: Map<String, Any?>?,
	val connection: TcpConnection,
	val host: String?,
	val port: Int?,
)

/** 在已挂 codec 的 socket 上创建原始 pipe。 */
private fun createTcpPipe(options: TcpPipeOptions, codec: LengthPrefixCodec): LinkPipe {
	val pipe = createLinkIdBoundPipe(
		LinkPipeOptions(
			providerId = "lan_tcp",
			level = LINK_LEVEL_LAN_TCP,
			initiator = options.initiator,
			nodeHash = options.nodeHash,
			localIdentity = options.localIdentity,
			sendControlText = { text -> codec.write(text.toByteArray(Charsets.UTF_8)) },
			sendFrame = { _, frame -> codec.write(frame) },
			closeTransport = {
				codec.destroy()
				options.connection.destroy()
			},
			extraStats = { linkedMapOf("host" to options.host, "port" to options.port?.toDouble()) },
		),
		options.linkId,
	)
	options.connection.onClose = { lanTcpScope.launch { pipe.close("socket-close") } }
	options.connection.onError = { lanTcpScope.launch { pipe.close("socket-error") } }
	return pipe
}

/**
 * 在已连接 socket 上建立 pipe（入站帧经 pending 缓冲，避免 link-open/hello 竞态丢包）。
 * @param options 配置
 * @return 已启动握手的 link
 */
private suspend fun openTcpPipe(options: TcpPipeOptions): LinkHandle {
	var pipe: LinkPipe? = null
	val pending = ArrayList<ByteArray>()
	val codec = LengthPrefixCodec(options.connection) { payload ->
		val current = pipe
		if (current == null) pending.add(payload) else current.handleInbound(payload)
	}
	val created = createTcpPipe(options, codec)
	pipe = created
	for (payload in pending.toList()) created.handleInbound(payload)
	pending.clear()
	if (options.initiator)
		codec.write(buildLinkOpen(options.linkId, options.localIdentity?.get("nodeHash")?.toString() ?: "").toByteArray(Charsets.UTF_8))
	created.startHandshake()
	return asLinkHandle(created)
}

/**
 * 拨号到已有 LAN hint。
 * @param options dial 选项
 * @return 已就绪的 link
 */
private suspend fun dialLanTcp(options: Map<String, Any?>): LinkHandle {
	val remoteNodeHash = options["nodeHash"]?.toString() ?: throw IllegalArgumentException("p2p: lan_tcp no peer hint")
	val hints = listLanPeerHints(remoteNodeHash)
	if (hints.isEmpty()) throw IllegalStateException("p2p: lan_tcp no peer hint")
	val dialer = tcpDialer ?: throw IllegalStateException("p2p: lan_tcp transport unavailable")
	@Suppress("UNCHECKED_CAST")
	val localIdentity = options["localIdentity"] as? Map<String, Any?>
	var lastError: Exception? = null
	for (hint in hints) {
		var connection: TcpConnection? = null
		try {
			connection = dialer.connect(hint.host, hint.port)
			val link = openTcpPipe(
				TcpPipeOptions(
					initiator = true,
					linkId = bytesToHex(randomBytes(32)),
					nodeHash = remoteNodeHash,
					localIdentity = localIdentity,
					connection = connection,
					host = hint.host,
					port = hint.port,
				),
			)
			link.ready.await()
			return link
		}
		catch (error: Exception) {
			lastError = error
			try {
				connection?.destroy()
			}
			catch (_: Exception) {
				// ignore
			}
		}
	}
	throw lastError ?: IllegalStateException("p2p: lan_tcp dial failed")
}

/**
 * 创建 lan_tcp LinkProvider。
 *
 * `providerId` 仍为 `lan_tcp`；TCP 由宿主注入的 [TcpDialer] 提供，未注入时 dial 抛错。
 * @return LAN TCP provider
 */
fun createLanTcpLinkProvider(): LinkProvider {
	val instanceId = "lan_tcp:" + bytesToHex(randomBytes(4))
	var inboundHandler: ((LinkHandle) -> Unit)? = null
	var identity: Map<String, Any?>? = null
	var server: TcpServer? = null

	fun acceptConnection(connection: TcpConnection) {
		val inbound = inboundHandler
		val localIdentity = identity
		if (inbound == null || localIdentity == null) {
			connection.destroy()
			return
		}
		lateinit var codec: LengthPrefixCodec
		var pipe: LinkPipe? = null
		fun handlePayload(payload: ByteArray) {
			val existing = pipe
			if (existing != null) {
				existing.handleInbound(payload)
				return
			}
			val opened = parseLinkOpen(payload)
			if (opened == null) {
				connection.destroy()
				return
			}
			val created = try {
				createTcpPipe(
					TcpPipeOptions(
						initiator = false,
						linkId = opened["linkId"].toString(),
						nodeHash = opened["from"]?.toString(),
						localIdentity = localIdentity,
						connection = connection,
						host = null,
						port = server?.port,
					),
					codec,
				)
			}
			catch (_: Exception) {
				connection.destroy()
				return
			}
			pipe = created
			inbound(asLinkHandle(created))
			lanTcpScope.launch {
				try {
					created.startHandshake()
				}
				catch (_: Exception) {
					connection.destroy()
				}
			}
		}
		codec = LengthPrefixCodec(connection, ::handlePayload)
	}

	return object : LinkProvider {
		override val id: String = instanceId
		override val level: Double = LINK_LEVEL_LAN_TCP
		override val caps: Map<String, Any?> = mapOf("needsOfferAnswer" to false, "needsDiscoverySignal" to false, "probe" to "sync")

		override suspend fun isAvailable(): Boolean = true

		override fun canReach(remote: Map<String, Any?>): Boolean = getLanPeerHint(remote["nodeHash"]?.toString()) != null

		override fun localEndpoint(): Map<String, Any?>? {
			val port = server?.port ?: return null
			return if (port > 0) mapOf("port" to port.toDouble()) else null
		}

		override suspend fun dial(options: Map<String, Any?>): LinkHandle = dialLanTcp(options)

		override suspend fun ensureListening(onInbound: (LinkHandle) -> Unit, localIdentity: Map<String, Any?>): () -> Unit {
			inboundHandler = onInbound
			identity = localIdentity
			if (server == null) {
				val dialer = tcpDialer ?: return {}
				server = dialer.listen(0) { connection -> acceptConnection(connection) }
			}
			return {
				inboundHandler = null
				server?.close()
				server = null
			}
		}
	}
}
