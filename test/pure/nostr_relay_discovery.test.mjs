import { createServer } from 'node:http'
import { test } from 'node:test'

import { WebSocketServer } from 'ws'

import { assert, assertEquals } from '../helpers/assert.mjs'

/**
 * 启动一个发送 NIP-66 30166 事件后 EOSE 的假中继（事件列表可变，启动后可 push）。
 * @param {object[]} [events] 要下发的事件（可变数组）
 * @returns {Promise<{ port: number, events: object[], stop: () => Promise<void> }>} 假中继
 */
async function startNip66Server(events = []) {
	const server = createServer((request, response) => {
		response.writeHead(200, { 'Content-Type': 'application/nostr+json', Connection: 'close' })
		response.end(JSON.stringify({ supported_nips: [1], limitation: { max_message_length: 262144 } }))
	})
	const wss = new WebSocketServer({ server })
	/** @type {Set<import('node:net').Socket>} */
	const sockets = new Set()
	server.on('connection', socket => {
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
	})
	wss.on('connection', socket => {
		socket.on('message', raw => {
			let parsed
			try { parsed = JSON.parse(String(raw)) } catch { return }
			if (parsed?.[0] !== 'REQ') return
			const subId = String(parsed[1])
			for (const event of events)
				socket.send(JSON.stringify(['EVENT', subId, event]))
			socket.send(JSON.stringify(['EOSE', subId]))
		})
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const port = server.address().port
	return {
		port,
		events,
		/**
		 * 停止假中继及其客户端连接。
		 * @returns {Promise<void>} 停止完成
		 */
		stop: async () => {
			// 先 terminate 所有 ws 客户端，再 destroy 全部底层 socket，最后关闭 server，避免 Windows uv 断言。
			for (const ws of wss.clients) try { ws.terminate() } catch { /* ignore */ }
			for (const socket of sockets) try { socket.destroy() } catch { /* ignore */ }
			await new Promise(resolve => {
				try { server.close(() => resolve()) }
				catch { resolve() }
			})
		},
	}
}

/**
 * @param {string} url d tag 中的 URL
 * @param {string} pubkey 上报 pubkey
 * @param {object} [extra] 额外 tag（同 key 覆盖默认）
 * @returns {object} 30166 事件
 */
function nip66Event(url, pubkey, extra = {}) {
	/** @type {Map<string, string>} */
	const tagMap = new Map([
		['d', url],
		['n', 'clearnet'],
		['N', '1'],
		['rtt-open', '25'],
	])
	for (const [key, value] of Object.entries(extra))
		if (value != null) tagMap.set(key, String(value))
	const tags = [...tagMap.entries()]
	return { id: `${pubkey}${Math.random().toString(36).slice(2)}`, pubkey, created_at: Date.now() / 1000, kind: 30166, tags, content: '' }
}

/**
 * 初始化 relay 测试状态。
 * @returns {Promise<object>} relay 模块
 */
async function setup() {
	const relays = await import('../../discovery/nostr/relays.mjs')
	let data = null
	relays.setRelayStorageIOForTests({
		/**
		 * 读取测试存储。
		 * @returns {object | null} 存储数据
		 */
		read: () => data,
		/**
		 *
		 * @param {object} value 存储数据
		 * @returns {void}
		 */
		write: value => { data = value }
	})
	relays.resetNostrRelaysForTests()
	relays.loadRelayPool()
	// 清空 public 种子：避免它们作为 NIP-66 bootstrap 兜底触发公网。
	relays.clearRelayPoolForTests()
	relays.setNostrRelayDiscoveryEnabledForTests(false)
	return relays
}

test('parseNip66Event normalizes d tag, filters clearnet and NIP-01', async () => {
	const { parseNip66Event } = await import('../../discovery/nostr/relays.mjs')
	const parsed = parseNip66Event(nip66Event('WSS://RELAY.EXAMPLE.COM/', 'aa'.repeat(32)))
	assertEquals(parsed.url, 'wss://relay.example.com')
	assertEquals(parsed.clearnet, true)
	assertEquals(parsed.rttMs, 25)
	assertEquals(parseNip66Event(nip66Event('wss://relay.example.com', 'aa'.repeat(32), { n: 'tor' })), null)
	assertEquals(parseNip66Event(nip66Event('wss://relay.example.com', 'aa'.repeat(32), { N: '2' })), null)
	assertEquals(parseNip66Event(nip66Event('not-a-url', 'aa'.repeat(32))), null)
	assert(parseNip66Event({ tags: [['d', 'wss://relay.example.com'], ['N', '1,40']] }), 'N-tag with NIP-01 accepted')
})

test('discoverNostrRelays trusts multi-monitor relays and gates single-monitor on probe', async () => {
	const relays = await setup()
	let serverA, serverB
	try {
		serverA = await startNip66Server()
		serverB = await startNip66Server()
		const urlA = `ws://127.0.0.1:${serverA.port}`
		const urlB = `ws://127.0.0.1:${serverB.port}`
		// serverA 自己上报 urlA；serverB 也上报 urlA（多源 → trusted），并上报 urlB（单源 → untrusted）。
		serverA.events.push(nip66Event(urlA, '11'.repeat(32)))
		serverB.events.push(
			nip66Event(urlA, '22'.repeat(32)),
			nip66Event(urlB, '33'.repeat(32)),
			nip66Event('wss://tor.example.com', '44'.repeat(32), { n: 'tor' }),
			nip66Event('wss://no-nip01.example.com', '55'.repeat(32), { N: '2' }),
		)
		relays.setNip66BootstrapRelaysForTests([`ws://127.0.0.1:${serverA.port}`, `ws://127.0.0.1:${serverB.port}`])

		const added = await relays.discoverNostrRelays()
		assert(added >= 2, `added ${added} relays`)

		const trusted = relays.getPoolByUrl().get(urlA)
		assert(trusted, 'trusted multi-monitor relay added')
		assertEquals(trusted.monitorCount, 2, 'counted across two pubkeys')
		assertEquals(trusted.source, 'nip66')

		const single = relays.getPoolByUrl().get(urlB)
		assert(single, 'single-monitor relay added after successful probe')
		assertEquals(single.monitorCount, 1)

		assertEquals(relays.getPoolByUrl().has('wss://tor.example.com'), false, 'tor filtered')
		assertEquals(relays.getPoolByUrl().has('wss://no-nip01.example.com'), false, 'no-nip01 filtered')
	}
	finally {
		await serverA?.stop()
		await serverB?.stop()
	}
})
