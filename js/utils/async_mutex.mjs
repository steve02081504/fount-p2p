/**
 * 进程内 per-key 异步互斥锁（队列式，避免 Promise 链堆积）。
 */

/** @type {Map<string, { locked: boolean, queue: Array<() => void> }>} */
const mutexes = new Map()

/**
 * @param {string} lockKey 锁键
 * @returns {{ locked: boolean, queue: Array<() => void> }} 互斥状态
 */
function mutexState(lockKey) {
	let state = mutexes.get(lockKey)
	if (!state) {
		state = { locked: false, queue: [] }
		mutexes.set(lockKey, state)
	}
	return state
}

/**
 * @param {string} lockKey 锁键
 * @param {{ locked: boolean, queue: Array<() => void> }} state 互斥状态
 * @returns {void}
 */
function releaseMutex(lockKey, state) {
	const next = state.queue.shift()
	if (next) queueMicrotask(next)
	else {
		state.locked = false
		mutexes.delete(lockKey)
	}
}

/**
 * 当前存活的互斥键数量（仅供测试观察锁表是否回落到基线）。
 * @returns {number} `mutexes` 中的键数量
 */
export function activeMutexCount() {
	return mutexes.size
}

/**
 * @param {string} key 锁键
 * @param {() => Promise<T>} criticalSection 临界区
 * @returns {Promise<T>} `criticalSection` 的解析结果
 * @template T
 */
export async function withAsyncMutex(key, criticalSection) {
	const lockKey = key
	const state = mutexState(lockKey)
	return new Promise((resolve, reject) => {
		/** 执行临界区并最终释放锁 */
		const run = () => {
			Promise.resolve()
				.then(criticalSection)
				.then(resolve, reject)
				.finally(() => releaseMutex(lockKey, state))
		}
		if (state.locked) state.queue.push(run)
		else {
			state.locked = true
			run()
		}
	})
}
