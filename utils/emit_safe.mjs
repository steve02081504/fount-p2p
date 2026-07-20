/**
 * 调用一组 listener，单次抛错不影响其余。
 * @param {Iterable<Function>} listeners 回调集合
 * @param {...unknown} args 传给每个 listener 的参数
 * @returns {void}
 */
export function emitSafe(listeners, ...args) {
	for (const listener of listeners)
		try { listener(...args) }
		catch { /* ignore */ }
}
