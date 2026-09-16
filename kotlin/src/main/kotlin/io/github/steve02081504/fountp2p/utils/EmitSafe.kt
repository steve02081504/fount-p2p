package io.github.steve02081504.fountp2p.utils

/**
 * 调用一组 listener，单次抛错不影响其余。
 * @param listeners 回调集合（参数以数组形式传入）
 * @param listenerArguments 传给每个 listener 的参数
 */
fun emitSafe(listeners: Iterable<(Array<out Any?>) -> Unit>, vararg listenerArguments: Any?) {
	for (listener in listeners)
		try {
			listener(listenerArguments)
		}
		catch (_: Throwable) {
			// ignore
		}
}
