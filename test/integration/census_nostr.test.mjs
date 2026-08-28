import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { WebSocket } from 'ws'

import {
	buildCensusPacketFromSeed,
	getNodePopulationEstimate,
	NOSTR_CENSUS_KIND,
	resetCensusEvents,
} from '../../discovery/nostr/census.mjs'
import { ensureNodeSeed, getNodeHash } from '../../node/identity.mjs'
import { setP2PFeatures } from '../../node/instance.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

/**
 * @param {() => boolean} predicate 断言条件
 * @param {number} [timeoutMs=5000] 超时
 * @returns {Promise<void>}
 */
async function waitUntil(predicate, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise(resolve => setTimeout(resolve, 20))
	}
	throw new Error(`waitUntil: 条件在 ${timeoutMs}ms 内未满足`)
}

/**
 * 经独立 ws 连接向中继发布 nostr EVENT。
 * @param {number} port 中继端口
 * @param {object} event 事件
 * @returns {Promise<void>}
 */
function publishViaWs(port, event) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`)
		ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])))
		ws.on('message', rawMessage => {
			const parsed = JSON.parse(String(rawMessage))
			if (parsed?.[0] !== 'OK') return
			ws.close()
			if (parsed[2] === true) resolve()
			else reject(new Error('relay rejected event'))
		})
		ws.on('error', reject)
	})
}

/**
 * 用随机身份生成一条已签名的 census 事件。
 * 走 census.mjs 的真实签名/消息路径（buildCensusPacketFromSeed），而非复制格式；
 * 用于模拟「relay 中已有若干条对端 census 数据」。
 * @param {{ p: number, ts?: number }} options 包含概率 p 与时间戳
 * @returns {Promise<object>} 可直接发布的 nostr EVENT
 */
async function buildSignedCensusEvent({ p, ts = Date.now() }) {
	const packet = await buildCensusPacketFromSeed(randomBytes(32).toString('hex'), { p, ts })
	return {
		id: randomBytes(32).toString('hex'),
		pubkey: packet.nodePubKey,
		created_at: Math.floor(Date.now() / 1000),
		kind: NOSTR_CENSUS_KIND,
		tags: [['t', 'fount'], ['x', 'census']],
		content: Buffer.from(JSON.stringify(packet), 'utf8').toString('base64'),
		sig: packet.sig,
	}
}

/**
 * 经单条 ws 连接批量发布多个事件（避免逐个新建连接的开销）。
 * @param {number} port 中继端口
 * @param {Array<object>} events 事件列表
 * @returns {Promise<void>}
 */
function publishBatchViaWs(port, events) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`)
		const expected = events.length
		let okCount = 0
		ws.on('open', () => {
			for (const event of events) ws.send(JSON.stringify(['EVENT', event]))
		})
		ws.on('message', rawMessage => {
			const parsed = JSON.parse(String(rawMessage))
			if (parsed?.[0] !== 'OK') return
			if (parsed[2] === true) okCount++
			if (okCount >= expected) {
				ws.close()
				resolve()
			}
		})
		ws.on('error', reject)
		ws.on('close', () => {
			if (okCount < expected) reject(new Error('publishBatchViaWs: socket closed early'))
		})
	})
}

/**
 * 在测试体内固定 Math.random 为指定值，结束（含异常）后恢复。
 * @param {number} value 固定值（0 或 1）
 * @param {() => Promise<void>} testFn 测试体
 * @returns {Promise<void>}
 */
async function withFixedRandom(value, testFn) {
	const originalRandom = Math.random
	/**
	 * @returns {number} 固定随机值
	 */
	Math.random = () => value
	try {
		await testFn()
	}
	finally {
		Math.random = originalRandom
	}
}

/**
 * 两个临时节点目录，传给 testFn，测试结束后清理两者。
 * @param {(dirA: string, dirB: string) => Promise<void>} testFn 测试函数
 * @returns {Promise<void>}
 */
async function withTwoNodes(testFn) {
	const dirA = await mkTestNodeDir('census-a-')
	const dirB = await mkTestNodeDir('census-b-')
	try {
		await testFn(dirA, dirB)
	}
	finally {
		await teardownTestNodeDir(dirA)
		await teardownTestNodeDir(dirB)
	}
}

test('census disabled gates subscription', async () => {
	const dir = await mkTestNodeDir('census-off-')
	try {
		initTestP2pNode({ nodeDir: dir })
		setP2PFeatures({ census: false })
		resetCensusEvents()
		assertEquals(getNodePopulationEstimate(), { estimate: 0, sampleSize: 0, eventsInWindow: 0 })
		const { createNostrDiscoveryProvider } = await import('../../discovery/nostr/index.mjs')
		const relay = await startFakeRelay()
		const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
		try {
			const stop = await provider.startPresence(async () => ({ nodeHash: getNodeHash() }))
			await relay.waitReqs(1)
			await new Promise(resolve => setTimeout(resolve, 50))
			assertEquals(relay.reqCount(), 1)
			stop()
		}
		finally {
			provider.dispose?.()
			await relay.stop()
		}
	}
	finally {
		await teardownTestNodeDir(dir)
	}
})

test('census ingests a verified peer event and estimates population', async () => {
	await withTwoNodes(async (dirA, dirB) => {
		initTestP2pNode({ nodeDir: dirB })
		const peerPacket = await buildCensusPacketFromSeed(ensureNodeSeed(), { p: 0.1, ts: Date.now() })

		initTestP2pNode({ nodeDir: dirA })
		setP2PFeatures({ census: true })
		resetCensusEvents()
		await withFixedRandom(1, async () => {
			const { createNostrDiscoveryProvider } = await import('../../discovery/nostr/index.mjs')
			const relay = await startFakeRelay(() => true, { broadcast: true })
			const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
			try {
				const stop = await provider.startPresence(async () => ({ nodeHash: getNodeHash() }))
				// advert 订阅 + census 订阅共用一条 socket
				await relay.waitReqs(2)
				assertEquals(relay.openCount(), 1)

				const peerEvent = {
					id: randomBytes(32).toString('hex'),
					pubkey: peerPacket.nodePubKey,
					created_at: Math.floor(Date.now() / 1000),
					kind: NOSTR_CENSUS_KIND,
					tags: [['t', 'fount'], ['x', 'census']],
					content: Buffer.from(JSON.stringify(peerPacket), 'utf8').toString('base64'),
					sig: peerPacket.sig,
				}
				await publishViaWs(relay.port, peerEvent)
				await waitUntil(() => getNodePopulationEstimate().sampleSize === 1)
				// 1/0.1 = 10（对端）+ 1（自身）= 11。
				assertEquals(getNodePopulationEstimate(), { estimate: 11, sampleSize: 1, eventsInWindow: 1 })
				stop()
			}
			finally {
				provider.dispose?.()
				await relay.stop()
			}
		})
	})
})

test('census excludes own event from sample but counts self once', async () => {
	await withTwoNodes(async (dirA, dirB) => {
		initTestP2pNode({ nodeDir: dirB })
		const peerPacket = await buildCensusPacketFromSeed(ensureNodeSeed(), { p: 0.1, ts: Date.now() })

		initTestP2pNode({ nodeDir: dirA })
		setP2PFeatures({ census: true })
		resetCensusEvents()
		await withFixedRandom(1, async () => {
			const { createNostrDiscoveryProvider } = await import('../../discovery/nostr/index.mjs')
			const relay = await startFakeRelay(() => true, { broadcast: true })
			const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
			try {
				const stop = await provider.startPresence(async () => ({ nodeHash: getNodeHash() }))
				await relay.waitReqs(2)
				// 单机：无任何事件，但 +1 计入自身 → 1，不是 0。
				assertEquals(getNodePopulationEstimate(), { estimate: 1, sampleSize: 0, eventsInWindow: 0 })

				// 自身事件（p=0.2）经中继回显到达：self 事件算进去（Σ 含其权重 1/0.2=5），
				// 同时 -1 把自身事件移出自己的数据（−5），再 +1（自身确定性存在）→ 仍为 1。
				const selfPacket = await buildCensusPacketFromSeed(ensureNodeSeed(), { p: 0.2, ts: Date.now() })
				const selfEvent = {
					id: randomBytes(32).toString('hex'),
					pubkey: selfPacket.nodePubKey,
					created_at: Math.floor(Date.now() / 1000),
					kind: NOSTR_CENSUS_KIND,
					tags: [['t', 'fount'], ['x', 'census']],
					content: Buffer.from(JSON.stringify(selfPacket), 'utf8').toString('base64'),
					sig: selfPacket.sig,
				}
				await publishViaWs(relay.port, selfEvent)
				await waitUntil(() => getNodePopulationEstimate().sampleSize === 1)
				assertEquals(getNodePopulationEstimate(), { estimate: 1, sampleSize: 1, eventsInWindow: 1 })

				// 对端事件计入：Σ = 5（自身）+ 10（对端）→ -5（移出自身）+ 1 = 11，自身不重复。
				const peerEvent = {
					id: randomBytes(32).toString('hex'),
					pubkey: peerPacket.nodePubKey,
					created_at: Math.floor(Date.now() / 1000),
					kind: NOSTR_CENSUS_KIND,
					tags: [['t', 'fount'], ['x', 'census']],
					content: Buffer.from(JSON.stringify(peerPacket), 'utf8').toString('base64'),
					sig: peerPacket.sig,
				}
				await publishViaWs(relay.port, peerEvent)
				await waitUntil(() => getNodePopulationEstimate().sampleSize === 2)
				assertEquals(getNodePopulationEstimate(), { estimate: 11, sampleSize: 2, eventsInWindow: 2 })
				stop()
			}
			finally {
				provider.dispose?.()
				await relay.stop()
			}
		})
	})
})

test('census publishes a signed event carrying its inclusion probability', async () => {
	const dir = await mkTestNodeDir('census-pub-')
	try {
		initTestP2pNode({ nodeDir: dir })
		setP2PFeatures({ census: true })
		resetCensusEvents()
		await withFixedRandom(0, async () => {
			const { createNostrDiscoveryProvider } = await import('../../discovery/nostr/index.mjs')
			const relay = await startFakeRelay(() => true)
			const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
			try {
				const stop = await provider.startPresence(async () => ({ nodeHash: getNodeHash() }))
				await waitUntil(() => relay.publishedEvents.some(event => event.kind === NOSTR_CENSUS_KIND))
				const censusEvent = relay.publishedEvents.find(event => event.kind === NOSTR_CENSUS_KIND)
				assertEquals(censusEvent.tags.some(tag => tag[0] === 't' && tag[1] === 'fount'), true)
				assertEquals(censusEvent.tags.some(tag => tag[0] === 'x' && tag[1] === 'census'), true)
				const { verifyCensusBytes } = await import('../../discovery/nostr/census.mjs')
				const verified = await verifyCensusBytes(
					Buffer.from(censusEvent.content, 'base64'),
					Date.now(),
				)
				assertEquals(verified.nodeHash, getNodeHash())
				assertEquals(verified.p > 0 && verified.p <= 1, true)
				stop()
			}
			finally {
				provider.dispose?.()
				await relay.stop()
			}
		})
	}
	finally {
		await teardownTestNodeDir(dir)
	}
})

test('census: 4 multiplier-1 peers on relay + joining node estimates 5', async () => {
	const dir = await mkTestNodeDir('census-count-')
	try {
		initTestP2pNode({ nodeDir: dir })
		setP2PFeatures({ census: true })
		resetCensusEvents()
		// 抑制 census worker 自动发布（避免它带自身 p 污染本测试手造的 p 值）。
		await withFixedRandom(1, async () => {
			const { createNostrDiscoveryProvider } = await import('../../discovery/nostr/index.mjs')
			const relay = await startFakeRelay(() => true, { broadcast: true })
			const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
			try {
				const stop = await provider.startPresence(async () => ({ nodeHash: getNodeHash() }))
				// advert 订阅 + census 订阅共用一条 socket
				await relay.waitReqs(2)

				// 4 条乘数为 1（p=1 → 每条贡献 1）的对端数据 + 自身（+1）= 5。
				const first = await buildSignedCensusEvent({ p: 1 })
				const second = await buildSignedCensusEvent({ p: 1 })
				const third = await buildSignedCensusEvent({ p: 1 })
				const fourth = await buildSignedCensusEvent({ p: 1 })
				await publishBatchViaWs(relay.port, [first, second, third, fourth])
				await waitUntil(() => getNodePopulationEstimate().sampleSize === 4)
				assertEquals(getNodePopulationEstimate(), { estimate: 5, sampleSize: 4, eventsInWindow: 4 })
				stop()
			}
			finally {
				provider.dispose?.()
				await relay.stop()
			}
		})
	}
	finally {
		await teardownTestNodeDir(dir)
	}
})

test('census: 200 nodes on an empty relay estimate 200', async () => {
	const dir = await mkTestNodeDir('census-200-')
	try {
		initTestP2pNode({ nodeDir: dir })
		setP2PFeatures({ census: true })
		resetCensusEvents()
		// 抑制 census worker 自动发布（避免它带自身 p 污染本测试手造的 p 值）。
		await withFixedRandom(1, async () => {
			const { createNostrDiscoveryProvider } = await import('../../discovery/nostr/index.mjs')
			const relay = await startFakeRelay(() => true, { broadcast: true })
			const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
			try {
				const stop = await provider.startPresence(async () => ({ nodeHash: getNodeHash() }))
				await relay.waitReqs(2)

				// 200 个节点（含观察者自身）：199 条乘数为 1 的对端事件 + 自身（+1）= 200。
				const events = []
				for (let index = 0; index < 199; index++)
					events.push(await buildSignedCensusEvent({ p: 1 }))
				await publishBatchViaWs(relay.port, events)
				await waitUntil(() => getNodePopulationEstimate().sampleSize === 199, 15000)
				assertEquals(getNodePopulationEstimate(), { estimate: 200, sampleSize: 199, eventsInWindow: 199 })
				stop()
			}
			finally {
				provider.dispose?.()
				await relay.stop()
			}
		})
	}
	finally {
		await teardownTestNodeDir(dir)
	}
})