import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { buildCensusPacketFromSeed } from '../../discovery/nostr/census.mjs'
import { createPopulationMonitor } from '../../discovery/nostr/census_monitor.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'

const CENSUS_KIND = 30789
const NIP66_KIND = 30166

/**
 * @param {number} index 序号
 * @returns {string} 确定性 64 hex seed
 */
function seed(index) {
	return index.toString(16).padStart(64, '0')
}

/**
 * 构建带合法签名的 census nostr 事件（供假中继广播）。
 * @param {string} seedHex 节点 seed
 * @param {number} p 包含概率
 * @returns {Promise<object>} nostr 事件
 */
async function buildCensusEvent(seedHex, p) {
	const packet = await buildCensusPacketFromSeed(seedHex, { p, ts: Date.now() })
	return {
		id: '0'.repeat(64),
		pubkey: '0'.repeat(64),
		created_at: Math.floor(Date.now() / 1000),
		kind: CENSUS_KIND,
		tags: [['t', 'fount'], ['x', 'census']],
		content: Buffer.from(JSON.stringify(packet), 'utf8').toString('base64'),
		sig: '0'.repeat(128),
	}
}

/**
 * 经独立 ws 连接向假中继发布 nostr EVENT（触发扇出广播）。
 * @param {number} port 中继端口
 * @param {object} event 事件
 * @returns {Promise<void>}
 */
function publishViaWs(port, event) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`)
		ws.addEventListener('open', () => ws.send(JSON.stringify(['EVENT', event])))
		ws.addEventListener('message', raw => {
			const parsed = JSON.parse(String(raw.data))
			if (parsed[0] === 'OK') {
				try { ws.close() } catch { /* ignore */ }
				resolve()
			}
		})
		ws.addEventListener('error', () => reject(new Error('publish ws error')))
	})
}

/**
 * @param {() => boolean} predicate 条件
 * @param {number} [timeoutMs=5000] 超时
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise(resolve => setTimeout(resolve, 20))
	}
	throw new Error(`waitFor: 条件在 ${timeoutMs}ms 内未满足`)
}

test('listens on provided relays and reports the most populous relay as display source', async () => {
	const relayA = await startFakeRelay(() => true, { broadcast: true })
	const relayB = await startFakeRelay(() => true, { broadcast: true })
	/** @type {Array<{ estimate: number, sampleSize: number, eventsInWindow: number, relayUrl: string, relays: number }>} */
	const snapshots = []
	const monitor = createPopulationMonitor({
		relays: [`ws://127.0.0.1:${relayA.port}`, `ws://127.0.0.1:${relayB.port}`],
		discover: false,
		onUpdate: snapshot => snapshots.push(snapshot),
	})
	try {
		await relayA.waitReqs(1)
		await relayB.waitReqs(1)
		for (const index of [1, 2, 3])
			await publishViaWs(relayA.port, await buildCensusEvent(seed(index), 0.1))
		await publishViaWs(relayB.port, await buildCensusEvent(seed(4), 0.1))
		await waitFor(() => snapshots.some(snapshot =>
			snapshot.relayUrl === `ws://127.0.0.1:${relayA.port}` && snapshot.estimate >= 30))
		const fromA = snapshots.find(snapshot =>
			snapshot.relayUrl === `ws://127.0.0.1:${relayA.port}` && snapshot.estimate >= 30)
		assertEquals(fromA.estimate, 30)
		assertEquals(fromA.sampleSize, 3)
		assertEquals(fromA.eventsInWindow, 3)
		assertEquals(fromA.relays, 2)

		for (const index of [5, 6, 7])
			await publishViaWs(relayB.port, await buildCensusEvent(seed(index), 0.1))
		await waitFor(() => snapshots.some(snapshot =>
			snapshot.relayUrl === `ws://127.0.0.1:${relayB.port}` && snapshot.estimate >= 40))
		const fromB = snapshots.find(snapshot =>
			snapshot.relayUrl === `ws://127.0.0.1:${relayB.port}` && snapshot.estimate >= 40)
		assertEquals(fromB.estimate, 40)
		assertEquals(fromB.sampleSize, 4)
	}
	finally {
		monitor.stop()
		await relayA.stop()
		await relayB.stop()
	}
})

test('NIP-66 discovery adds candidate relays and they feed the display', async () => {
	const discoveryRelay = await startFakeRelay(() => true, { broadcast: true })
	const targetRelay = await startFakeRelay(() => true, { broadcast: true })
	/** @type {Array<{ estimate: number, sampleSize: number, eventsInWindow: number, relayUrl: string, relays: number }>} */
	const snapshots = []
	const monitor = createPopulationMonitor({
		relays: [`ws://127.0.0.1:${discoveryRelay.port}`],
		nip66Bootstrap: [`ws://127.0.0.1:${discoveryRelay.port}`],
		onUpdate: snapshot => snapshots.push(snapshot),
	})
	try {
		await discoveryRelay.waitReqs(2)
		await publishViaWs(discoveryRelay.port, {
			id: '0'.repeat(64),
			pubkey: '0'.repeat(64),
			created_at: Math.floor(Date.now() / 1000),
			kind: NIP66_KIND,
			tags: [['d', `ws://127.0.0.1:${targetRelay.port}`]],
			content: '',
			sig: '0'.repeat(128),
		})
		await targetRelay.waitReqs(1)
		await publishViaWs(targetRelay.port, await buildCensusEvent(seed(9), 0.1))
		await waitFor(() => snapshots.some(snapshot =>
			snapshot.relayUrl === `ws://127.0.0.1:${targetRelay.port}` && snapshot.estimate >= 10))
		const discovered = snapshots.find(snapshot =>
			snapshot.relayUrl === `ws://127.0.0.1:${targetRelay.port}` && snapshot.estimate >= 10)
		assertEquals(discovered.estimate, 10)
		assertEquals(discovered.relays, 2)
	}
	finally {
		monitor.stop()
		await discoveryRelay.stop()
		await targetRelay.stop()
	}
})

test('stop closes connections to all relays', async () => {
	const relay = await startFakeRelay(() => true, { broadcast: true })
	const monitor = createPopulationMonitor({
		relays: [`ws://127.0.0.1:${relay.port}`],
		discover: false,
		onUpdate: () => { },
	})
	try {
		await relay.waitReqs(1)
		monitor.stop()
		await relay.waitClosed()
		assertEquals(relay.openCount(), 0)
	}
	finally {
		await relay.stop()
	}
})
