import { test } from 'node:test'

import { createPeerHealthTracker } from '../../transport/peer_health.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

const PEER = identity(2).nodeHash

/**
 * 创建 mock registry 与 mock link 的测试夹具。
 * @returns {{ tracker: ReturnType<typeof createPeerHealthTracker>, registry: { emitUp: (nodeHash: string, link: object) => void, emitDown: (nodeHash: string) => void }, link: { emitRtt: () => void, emitDown: () => void } }} 测试夹具
 */
function setup() {
	/** @type {Set<(nodeHash: string, link: object) => void>} */
	const upListeners = new Set()
	/** @type {Set<(nodeHash: string) => void>} */
	const downListeners = new Set()
	const registry = {
		/**
		 * @param {(nodeHash: string, link: object) => void} listener link up 回调
		 * @returns {() => void} 取消订阅
		 */
		onLinkUp: listener => {
			upListeners.add(listener)
			return () => upListeners.delete(listener)
		},
		/**
		 * @param {(nodeHash: string) => void} listener link down 回调
		 * @returns {() => void} 取消订阅
		 */
		onLinkDown: listener => {
			downListeners.add(listener)
			return () => downListeners.delete(listener)
		},
		/**
		 * @param {string} nodeHash 远端节点
		 * @param {object} link 链路
		 * @returns {void}
		 */
		emitUp(nodeHash, link) {
			for (const listener of upListeners) listener(nodeHash, link)
		},
		/**
		 * @param {string} nodeHash 远端节点
		 * @returns {void}
		 */
		emitDown(nodeHash) {
			for (const listener of downListeners) listener(nodeHash)
		},
	}
	/** @type {Set<() => void>} */
	const rttListeners = new Set()
	/** @type {Set<(reason: string) => void>} */
	const linkDownListeners = new Set()
	const link = {
		providerId: 'mock',
		/**
		 * @returns {object} stats 快照
		 */
		stats: () => ({ rttMs: 42, avgRttMs: 40 }),
		/**
		 * @param {() => void} callback RTT 回调
		 * @returns {() => void} 取消订阅
		 */
		onRtt: callback => {
			rttListeners.add(callback)
			return () => rttListeners.delete(callback)
		},
		/**
		 * @param {(reason: string) => void} callback down 回调
		 * @returns {() => void} 取消订阅
		 */
		onDown: callback => {
			linkDownListeners.add(callback)
			return () => linkDownListeners.delete(callback)
		},
		/**
		 * @returns {void}
		 */
		emitRtt() {
			for (const listener of rttListeners) listener()
		},
		/**
		 * @returns {void}
		 */
		emitDown() {
			for (const listener of linkDownListeners) listener('remote-hangup')
		},
	}
	const tracker = createPeerHealthTracker(registry)
	return { tracker, registry, link }
}

test('peer health: link up registers connected entry with source', () => {
	const { tracker, registry, link } = setup()
	registry.emitUp(PEER, link)
	const entry = tracker.getPeerHealth(PEER)
	assertEquals(entry.nodeHash, PEER)
	assertEquals(entry.connected, true)
	assertEquals(entry.rttMs, null)
	assertEquals(entry.avgRttMs, null)
	assertEquals(entry.lastSeenAt > 0, true)
	assertEquals(entry.source, 'mock')
})

test('peer health: onRtt updates rttMs / avgRttMs / lastSeenAt', async () => {
	const { tracker, registry, link } = setup()
	registry.emitUp(PEER, link)
	const lastSeenAtBeforeRtt = tracker.getPeerHealth(PEER).lastSeenAt
	await new Promise(resolve => setTimeout(resolve, 5))
	link.emitRtt()
	const entry = tracker.getPeerHealth(PEER)
	assertEquals(entry.rttMs, 42)
	assertEquals(entry.avgRttMs, 40)
	assertEquals(entry.lastSeenAt > lastSeenAtBeforeRtt, true)
})

test('peer health: link down marks disconnected and keeps last record', () => {
	const { tracker, registry, link } = setup()
	registry.emitUp(PEER, link)
	link.emitRtt()
	link.emitDown()
	const entry = tracker.getPeerHealth(PEER)
	assertEquals(entry.connected, false)
	assertEquals(entry.rttMs, 42)
	assertEquals(typeof entry.lastSeenAt, 'number')
})

test('peer health: registry onLinkDown also marks disconnected', () => {
	const { tracker, registry, link } = setup()
	registry.emitUp(PEER, link)
	registry.emitDown(PEER)
	assertEquals(tracker.getPeerHealth(PEER).connected, false)
})

test('peer health: listPeerHealth returns public entries without cleanup field', () => {
	const { tracker, registry, link } = setup()
	registry.emitUp(PEER, link)
	const list = tracker.listPeerHealth()
	assertEquals(list.length, 1)
	assertEquals(list[0].nodeHash, PEER)
	assertEquals('_cleanup' in list[0], false)
})

test('peer health: onPeerHealth notifies on changes', () => {
	const { tracker, registry, link } = setup()
	/** @type {string[]} */
	const seen = []
	const unsubscribe = tracker.onPeerHealth((nodeHash, entry) => { seen.push(`${nodeHash}:${entry.connected}`) })
	registry.emitUp(PEER, link)
	link.emitDown()
	assertEquals(seen, [`${PEER}:true`, `${PEER}:false`])
	unsubscribe()
})

test('peer health: unknown node returns null; stop clears entries', () => {
	const { tracker, registry, link } = setup()
	assertEquals(tracker.getPeerHealth(PEER), null)
	registry.emitUp(PEER, link)
	tracker.stop()
	assertEquals(tracker.listPeerHealth().length, 0)
})
