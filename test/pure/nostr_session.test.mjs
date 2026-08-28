import { test } from 'node:test'

import { connectRelay, pinnedLookup } from '../../discovery/nostr/session.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'

test('connectRelay pins the socket to the validated address (no uncontrolled second DNS resolution)', async () => {
	const fakeRelay = await startFakeRelay()
	try {
		const connectTarget = { hostname: '127.0.0.1', addresses: ['127.0.0.1'] }
		const ws = await connectRelay(`ws://nonexistent.invalid:${fakeRelay.port}`, 3_000, undefined, connectTarget)
		assert(ws.readyState === 1, '应经钉死的地址连上，尽管 URL hostname 不可解析')
		ws.terminate()
	}
	finally {
		await fakeRelay.stop()
	}
})

test('connectRelay accepts an async resolver as the connect target', async () => {
	const fakeRelay = await startFakeRelay()
	try {
		const ws = await connectRelay(
			`ws://bogus.invalid:${fakeRelay.port}`,
			3_000,
			undefined,
			async () => ({ hostname: '127.0.0.1', addresses: ['127.0.0.1'] }),
		)
		assert(ws.readyState === 1, '应经解析函数返回的地址连上')
		ws.terminate()
	}
	finally {
		await fakeRelay.stop()
	}
})

test('connectRelay without a connect target falls back to the default lookup', async () => {
	const fakeRelay = await startFakeRelay()
	try {
		const ws = await connectRelay(`ws://127.0.0.1:${fakeRelay.port}`, 3_000)
		assert(ws.readyState === 1, '无连接目标时仍应正常连接（受信中继/回环）')
		ws.terminate()
	}
	finally {
		await fakeRelay.stop()
	}
})

test('pinnedLookup returns pinned addresses in single and all mode', async () => {
	const lookup = pinnedLookup(['127.0.0.1', '::1'])
	await new Promise((resolve, reject) => {
		/**
		 * @param {Error | null} error 错误
		 * @param {string} address 地址
		 * @param {number} family 地址族
		 * @returns {void}
		 */
		lookup('whatever.invalid', (error, address, family) => {
			if (error) return reject(error)
			assertEquals(address, '127.0.0.1')
			assertEquals(family, 4)
			resolve()
		})
	})
	await new Promise((resolve, reject) => {
		/**
		 * @param {Error | null} error 错误
		 * @param {Array<{ address: string, family: number }>} addresses 地址列表
		 * @param {number} family 地址族
		 * @returns {void}
		 */
		lookup('whatever.invalid', { all: true }, (error, addresses, family) => {
			if (error) return reject(error)
			assertEquals(addresses, [
				{ address: '127.0.0.1', family: 4 },
				{ address: '::1', family: 6 },
			])
			assertEquals(family, 4)
			resolve()
		})
	})
})
