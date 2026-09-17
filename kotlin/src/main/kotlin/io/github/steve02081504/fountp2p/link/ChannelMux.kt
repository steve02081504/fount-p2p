package io.github.steve02081504.fountp2p.link

/** control 通道名：低延迟、小载荷与路由类消息。 */
const val CHANNEL_CONTROL = "control"

/** bulk 通道名：大载荷与低优先级消息。 */
const val CHANNEL_BULK = "bulk"

/** bufferedAmount 低水位默认阈值（256 KiB）。 */
const val CHANNEL_LOW_THRESHOLD_BYTES = 256 * 1024

/** 发送队列高水位默认阈值（1 MiB）。 */
const val CHANNEL_HIGH_WATERMARK_BYTES = 1024 * 1024

/** 超过此字节数优先走 bulk 通道（64 KiB）。 */
const val BULK_CHANNEL_MIN_BYTES = 64 * 1024

/**
 * channel_mux 依赖的最小 RTCDataChannel 抽象（Android 无 WebRTC 原生实现）。
 */
interface RtcDataChannel {
	/** 通道标签（`control` / `bulk`）。 */
	val label: String

	/** 通道就绪状态（`open` / `connecting` / `closing` / `closed`）。 */
	val readyState: String

	/** 缓冲区待发送字节数。 */
	var bufferedAmount: Double

	/** 低水位阈值（字节）。 */
	var bufferedAmountLowThreshold: Double

	/** 低水位回调。 */
	var onBufferedAmountLow: (() -> Unit)?

	/** 通道打开回调。 */
	var onOpen: (() -> Unit)?

	/** 通道关闭回调。 */
	var onClose: (() -> Unit)?

	/** 入站消息回调（String 或 ByteArray）。 */
	var onMessage: ((Any?) -> Unit)?

	/**
	 * 发送字节。
	 * @param bytes 载荷
	 */
	fun send(bytes: ByteArray)

	/** 关闭通道。 */
	fun close()
}

private val DEFAULT_ACTION_PRIORITIES: Map<String, Int> = mapOf(
	"dag_event" to 0,
	"gossip_request" to 1,
	"gossip_response" to 2,
	"channel_history_want" to 2,
	"fed_bootstrap_request" to 2,
	"fed_bootstrap_response" to 2,
	"fed_join_snapshot_request" to 2,
	"fed_archive_month_want" to 2,
	"fed_archive_month_response" to 2,
	"mailbox_put" to 2,
	"mailbox_want" to 2,
	"mailbox_give" to 2,
	"fed_tip_ping" to 3,
	"discovery_announce" to 3,
	"discovery_query" to 3,
	"discovery_query_response" to 3,
	"part_invoke" to 3,
	"part_invoke_response" to 3,
	"part_query_req" to 5,
	"part_query_res" to 5,
	"char_rpc" to 3,
	"fed_chunk_put" to 5,
	"fed_chunk_get" to 5,
	"fed_chunk_data" to 5,
	"fed_chunk_ack" to 5,
	"fed_manifest_get" to 5,
	"fed_manifest_data" to 5,
	"fed_partition_bridge" to 5,
	"fed_volatile" to 10,
)

/**
 * 根据 action 名称解析发送优先级，数值越小越优先。
 * @param action 消息 action 名称
 * @return 优先级（未知 action 默认 5）
 */
fun resolveActionPriority(action: String): Int = DEFAULT_ACTION_PRIORITIES[action] ?: 5

/**
 * 根据 action 与载荷大小选择 control 或 bulk 通道。
 * @param action 消息 action 名称
 * @param byteLength 载荷字节长度
 * @return 目标通道名
 */
fun pickChannel(action: String, byteLength: Int): String {
	if (action == "ping" || action == "pong" || action.startsWith("route_")) return CHANNEL_CONTROL
	if (byteLength > BULK_CHANNEL_MIN_BYTES) return CHANNEL_BULK
	return if (resolveActionPriority(action) <= 3) CHANNEL_CONTROL else CHANNEL_BULK
}

/**
 * 读取 RTC 数据通道当前 bufferedAmount。
 * @param channel RTC 数据通道
 * @return 缓冲区待发送字节数
 */
fun readBufferedAmount(channel: RtcDataChannel): Double = channel.bufferedAmount

/**
 * 配置数据通道的 bufferedAmountLowThreshold。
 * @param channel RTC 数据通道
 * @param thresholdBytes 低水位阈值（字节）
 * @return 实际生效的阈值
 */
@JvmOverloads
fun configureBufferedAmountLowThreshold(
	channel: RtcDataChannel,
	thresholdBytes: Double = CHANNEL_LOW_THRESHOLD_BYTES.toDouble(),
): Double {
	channel.bufferedAmountLowThreshold = thresholdBytes
	return channel.bufferedAmountLowThreshold
}

/**
 * 订阅 bufferedamountlow 事件，返回取消订阅函数。
 * @param channel RTC 数据通道
 * @param callback 低水位回调
 * @return 取消订阅函数
 */
fun onBufferedAmountLow(channel: RtcDataChannel, callback: () -> Unit): () -> Unit {
	channel.onBufferedAmountLow = callback
	return {
		if (channel.onBufferedAmountLow === callback) channel.onBufferedAmountLow = null
		Unit
	}
}

/**
 * 创建带优先级队列的双通道发送器（control/bulk）。
 * @param getChannel 通道访问
 * @param highWatermarkBytes 高水位配置
 * @param scheduleFlush 调度 flush 的函数（默认同步执行；测试/JS 微任务语义可注入）
 */
class ChannelSendQueues(
	private val getChannel: (String) -> RtcDataChannel?,
	highWatermarkBytes: Any? = null,
	private val scheduleFlush: (() -> Unit) -> Unit = { it() },
) {
	private class Item(val priority: Int, val seq: Int, val bytes: ByteArray)

	private val highWatermarkBytes = maxOf(
		CHANNEL_LOW_THRESHOLD_BYTES.toDouble(),
		(highWatermarkBytes as? Number)?.toDouble() ?: CHANNEL_HIGH_WATERMARK_BYTES.toDouble(),
	)
	private val queues = mapOf(
		CHANNEL_CONTROL to ArrayList<Item>(),
		CHANNEL_BULK to ArrayList<Item>(),
	)
	private val scheduled = hashMapOf(CHANNEL_CONTROL to false, CHANNEL_BULK to false)
	private var seq = 0

	private fun schedule(channelName: String) {
		if (scheduled[channelName] == true) return
		scheduled[channelName] = true
		scheduleFlush { flushNow(channelName) }
	}

	private fun flushNow(channelName: String) {
		scheduled[channelName] = false
		val channel = getChannel(channelName)
		if (channel?.readyState != "open") return
		val queue = queues[channelName] ?: return
		var sent = 0
		while (sent < queue.size) {
			if (readBufferedAmount(channel) > highWatermarkBytes) break
			channel.send(queue[sent++].bytes)
		}
		if (sent > 0) repeat(sent) { if (queue.isNotEmpty()) queue.removeAt(0) }
	}

	/**
	 * 按优先级将字节帧入队并调度发送。
	 * @param action 消息 action（用于选通道与优先级）
	 * @param bytes 待发送帧字节
	 * @param preferredChannel 强制使用的通道，省略则自动选择
	 */
	@JvmOverloads
	fun enqueue(action: String, bytes: ByteArray, preferredChannel: String? = null) {
		val channelName = preferredChannel ?: pickChannel(action, bytes.size)
		val queue = queues[channelName] ?: return
		val priority = resolveActionPriority(action)
		val item = Item(priority, ++seq, bytes)
		var lo = 0
		var hi = queue.size
		while (lo < hi) {
			val mid = (lo + hi) ushr 1
			val existing = queue[mid]
			val compare = (priority - existing.priority).let { if (it != 0) it else item.seq - existing.seq }
			if (compare < 0) hi = mid else lo = mid + 1
		}
		queue.add(lo, item)
		schedule(channelName)
	}

	/**
	 * 调度 flush：指定通道或双通道。
	 * @param channelName 通道名，省略则 flush 全部
	 */
	@JvmOverloads
	fun flush(channelName: String? = null) {
		if (channelName != null) schedule(channelName)
		else {
			schedule(CHANNEL_CONTROL)
			schedule(CHANNEL_BULK)
		}
	}

	/** @return 各通道待发送帧数量 */
	fun pending(): Map<String, Int> =
		linkedMapOf(CHANNEL_CONTROL to (queues[CHANNEL_CONTROL]?.size ?: 0), CHANNEL_BULK to (queues[CHANNEL_BULK]?.size ?: 0))

	/** 清空所有发送队列。 */
	fun clear() {
		queues[CHANNEL_CONTROL]?.clear()
		queues[CHANNEL_BULK]?.clear()
	}
}

/**
 * 创建带优先级队列的双通道发送器（等价 JS `createChannelSendQueues`）。
 * @param getChannel 通道访问
 * @param highWatermarkBytes 高水位配置
 * @return 发送队列 API
 */
@JvmOverloads
fun createChannelSendQueues(
	getChannel: (String) -> RtcDataChannel?,
	highWatermarkBytes: Any? = null,
): ChannelSendQueues = ChannelSendQueues(getChannel, highWatermarkBytes)
