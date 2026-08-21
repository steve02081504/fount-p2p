/**
 * 节点生命周期内打开的文件流注册表。
 *
 * 文件流（chunk 读流 / 写流）在 Windows 上若未 destroy 会占用文件句柄，
 * 导致节点目录删除失败。这里集中跟踪，`closeNode()` 通过
 * `closeAllFileStreams()` 一次性释放全部仍打开的流。
 */

/** @type {Set<import('node:stream').Readable | import('node:stream').Writable>} */
const streams = new Set()

/**
 * 跟踪一个文件流：销毁/关闭/出错时自动从注册表移除。
 * @template {import('node:stream').Readable | import('node:stream').Writable} T
 * @param {T} stream 文件流
 * @returns {T} 原流
 */
export function trackFileStream(stream) {
	streams.add(stream)
	/** @returns {void} */
	const forget = () => streams.delete(stream)
	stream.once('close', forget)
	stream.once('error', forget)
	return stream
}

/**
 * 关闭并销毁所有仍在打开的文件流（测试 teardown / 节点关闭）。
 * @returns {Promise<number>} 被销毁的流数量
 */
export async function closeAllFileStreams() {
	let count = 0
	const pending = []
	for (const stream of streams) {
		count++
		if (!stream.closed)
			pending.push(new Promise(resolve => stream.once('close', resolve)))
		stream.destroy()
	}
	await Promise.all(pending)
	streams.clear()
	return count
}

/**
 * @returns {boolean} 是否仍有未释放的文件流（测试断言用）
 */
export function hasOpenFileStreams() {
	return streams.size > 0
}
