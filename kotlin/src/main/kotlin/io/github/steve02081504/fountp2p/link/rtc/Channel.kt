package io.github.steve02081504.fountp2p.link.rtc

import io.github.steve02081504.fountp2p.link.RtcDataChannel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

/**
 * 等待 data channel 进入 open 或 close 状态，超时则抛错。
 * 同一 channel 可并发等待：新订阅链式调用已有 onopen/onclose，cleanup 只摘掉自身。
 * @param channel RTC 数据通道
 * @param eventName 目标状态事件名（`open` / `close`）
 * @param timeoutMs 超时毫秒数
 */
suspend fun waitForChannelState(channel: RtcDataChannel, eventName: String, timeoutMs: Long) {
	if (eventName == "open" && channel.readyState == "open") return
	if (eventName == "close" && channel.readyState == "closed") return
	try {
		withTimeout(timeoutMs) {
			val deferred = CompletableDeferred<Unit>()
			val previous = if (eventName == "open") channel.onOpen else channel.onClose
			val handler: () -> Unit = {
				previous?.invoke()
				if (!deferred.isCompleted) deferred.complete(Unit)
			}
			if (eventName == "open") channel.onOpen = handler else channel.onClose = handler
			try {
				deferred.await()
			}
			finally {
				if (eventName == "open") {
					if (channel.onOpen === handler) channel.onOpen = previous
				}
				else if (channel.onClose === handler) channel.onClose = previous
			}
		}
	}
	catch (_: TimeoutCancellationException) {
		throw IllegalStateException("p2p: data channel $eventName timeout after ${timeoutMs}ms")
	}
}
