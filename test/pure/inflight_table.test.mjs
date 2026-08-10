import { test } from 'node:test'

import { ms } from '../../utils/duration.mjs'
import { createInflightTable } from '../../utils/inflight_table.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/**
 * @param {number} [ms] 延迟
 * @returns {Promise<void>}
 */
function delay(ms = 0) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

test('inflight acquire reuses same done and touches to tail', async () => {
	let starts = 0
	/** @type {((v: string | null) => void) | null} */
	let settle = null
	const table = createInflightTable({ maxSize: 8, baseTimeoutMs: ms('1s') })

	const first = table.acquire('a', () => {
		starts++
		const done = new Promise(resolve => { settle = resolve })
		return {
			done,
			cancel: () => settle?.(null),
		}
	})
	const second = table.acquire('a', () => {
		starts++
		throw new Error('must not start again')
	})
	assertEquals(starts, 1)
	assertEquals(first, second)
	assertEquals(table.size(), 1)

	settle?.('ok')
	assertEquals(await first, 'ok')
	assertEquals(await second, 'ok')
	await delay()
	assertEquals(table.size(), 0)
})

test('inflight refuses new key when full and front is still within baseTimeout', () => {
	let clock = 1000
	const table = createInflightTable({
		maxSize: 2,
		baseTimeoutMs: 500,
		now: () => clock,
	})
	/** @type {Array<() => void>} */
	const cancels = []

	/**
	 * @param {string} key 键
	 * @returns {Promise<string | null> | null} 共享 promise
	 */
	function start(key) {
		return table.acquire(key, () => {
			let settled = false
			/** @type {(v: string | null) => void} */
			let resolve
			const done = new Promise(r => { resolve = r })
			cancels.push(() => {
				if (settled) return
				settled = true
				resolve(null)
			})
			return {
				done,
				cancel: cancels[cancels.length - 1],
			}
		})
	}

	assertEquals(Boolean(start('a')), true)
	assertEquals(Boolean(start('b')), true)
	assertEquals(table.size(), 2)
	assertEquals(start('c'), null)
	assertEquals(cancels.length, 2)
})

test('inflight cancels aged front only when over cap (dual window)', async () => {
	let clock = 0
	const table = createInflightTable({
		maxSize: 2,
		baseTimeoutMs: 100,
		now: () => clock,
	})
	/** @type {string[]} */
	const cancelled = []

	/**
	 * @param {string} key 键
	 * @returns {Promise<string | null> | null}
	 */
	function start(key) {
		return table.acquire(key, () => {
			/** @type {(v: string | null) => void} */
			let resolve
			const done = new Promise(r => { resolve = r })
			return {
				done,
				cancel: () => {
					cancelled.push(key)
					resolve(null)
				},
			}
		})
	}

	assertEquals(Boolean(start('old')), true)
	clock = 50
	assertEquals(Boolean(start('mid')), true)
	clock = 150
	// old aged (>=100) and at front; admitting 'new' needs a slot → cancel old
	const newest = start('new')
	assertEquals(Boolean(newest), true)
	assertEquals(cancelled, ['old'])
	assertEquals(table.has('old'), false)
	assertEquals(table.has('mid'), true)
	assertEquals(table.has('new'), true)
	assertEquals(table.size(), 2)

	table.clear()
	await delay()
})

test('reuse touches key so a fresher sibling is cancelled first under pressure', () => {
	let clock = 0
	const table = createInflightTable({
		maxSize: 2,
		baseTimeoutMs: 10,
		now: () => clock,
	})
	/** @type {string[]} */
	const cancelled = []

	/**
	 * @param {string} key 键
	 * @returns {Promise<unknown> | null}
	 */
	function start(key) {
		return table.acquire(key, () => {
			/** @type {(v: null) => void} */
			let resolve
			const done = new Promise(r => { resolve = r })
			return {
				done,
				cancel: () => {
					cancelled.push(key)
					resolve(null)
				},
			}
		})
	}

	start('a')
	clock = 1
	start('b')
	clock = 2
	// touch a → order becomes b, a
	start('a')
	clock = 100
	start('c')
	assertEquals(cancelled, ['b'])
	assertEquals(table.has('a'), true)
	assertEquals(table.has('c'), true)
	table.clear()
})
