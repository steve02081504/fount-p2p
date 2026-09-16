package io.github.steve02081504.fountp2p.node

import kotlinx.coroutines.CompletableDeferred

/**
 * 节点生命周期内打开的文件流注册表（等价 `node/handles.mjs`）。
 *
 * 文件流（chunk 读流 / 写流）在 Windows 上若未 destroy 会占用文件句柄，导致节点目录
 * 删除失败。这里集中跟踪，`closeNode()` 通过 [closeAllFileStreams] 一次性释放全部
 * 仍打开的流。
 *
 * JS 侧流是 `node:stream` 的 Readable/Writable；Kotlin/JVM 无等价对象，故以
 * [TrackedFileStream] 抽象（`closed` / `destroy()` / close 与 error 监听）。
 */
interface TrackedFileStream {
	/** @return 是否已关闭 */
	val closed: Boolean

	/** 关闭并销毁该流 */
	fun destroy()

	/** @param listener 关闭时回调 */
	fun onClose(listener: () -> Unit)

	/** @param listener 出错时回调 */
	fun onError(listener: () -> Unit)
}

private val streams = LinkedHashSet<TrackedFileStream>()
private val streamsGuard = Any()

/**
 * 跟踪一个文件流：销毁/关闭/出错时自动从注册表移除。
 * @param stream 文件流
 * @return 原流
 */
fun <T : TrackedFileStream> trackFileStream(stream: T): T {
	synchronized(streamsGuard) { streams.add(stream) }
	val forget: () -> Unit = { synchronized(streamsGuard) { streams.remove(stream) }; Unit }
	stream.onClose(forget)
	stream.onError(forget)
	return stream
}

/**
 * 关闭并销毁所有仍在打开的文件流（测试 teardown / 节点关闭）。
 * @return 被销毁的流数量
 */
suspend fun closeAllFileStreams(): Int {
	val targeted = synchronized(streamsGuard) { streams.toList() }
	val pending = ArrayList<CompletableDeferred<Unit>>()
	for (stream in targeted) {
		if (!stream.closed) {
			val deferred = CompletableDeferred<Unit>()
			stream.onClose { deferred.complete(Unit) }
			pending.add(deferred)
		}
		stream.destroy()
	}
	for (deferred in pending) deferred.await()
	synchronized(streamsGuard) { streams.removeAll(targeted.toSet()) }
	return targeted.size
}

/** @return 是否仍有未释放的文件流（测试断言用） */
fun hasOpenFileStreams(): Boolean = synchronized(streamsGuard) { streams.isNotEmpty() }
