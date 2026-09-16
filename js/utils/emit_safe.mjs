/**
 * 调用一组 listener，单次抛错不影响其余。
 * @param {Iterable<Function>} listeners 回调集合
 * @param {...unknown} listenerArguments 传给每个 listener 的参数
 * @returns {void}
 */
export function emitSafe(listeners, ...listenerArguments) {
	for (const listener of listeners)
		try { listener(...listenerArguments) }
		catch { /* ignore */ }
}
