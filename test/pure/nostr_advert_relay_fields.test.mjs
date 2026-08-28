import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { buildSignedAdvert, verifySignedAdvert, sanitizeAdvertRelayFields, canonicalAdvertRelayBlob } from '../../link/handshake.mjs'
import { MAX_ADVERT_RELAY_POOL, MAX_ADVERT_LISTEN_RELAYS, MAX_RTT_MS } from '../../discovery/nostr/constants.mjs'
import { setNodeLogger } from '../../node/instance.mjs'
import { setConnectivityDebug } from '../../node/log.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

const RENDEZVOUS = 'rdv:test'

/**
 * 初始化日志捕获和测试节点。
 * @returns {Promise<{ messages: string[], nodeDir: string }>} 日志与节点目录
 */
async function setupLogger() {
	const nodeDir = await mkTestNodeDir('fount-p2p-advert-')
	initTestP2pNode({ nodeDir })
	const messages = []
	const logger = {
		/**
		 * 记录普通日志。
		 * @param {...any} args 日志参数
		 * @returns {void}
		 */
		info: (...args) => messages.push(args.map(String).join(' ')),
		/**
		 * 忽略错误日志。
		 * @returns {void}
		 */
		error: () => { },
	}
	setNodeLogger(logger)
	setConnectivityDebug(true)
	return { messages, nodeDir }
}

test('buildSignedAdvert carries sanitized pool/listen and verifies roundtrip', async () => {
	const local = identity(21)
	const pool = [
		{ url: 'wss://pool-a.example.com', rttMs: 42 },
		{ url: 'wss://pool-b.example.com', rttMs: 55 },
	]
	const listen = ['wss://listen-a.example.com', 'wss://listen-b.example.com']
	const advert = await buildSignedAdvert(RENDEZVOUS, 1234, {
		...local,
		nostrRelayPool: pool,
		listenNostrRelays: listen,
	})
	assertEquals(advert.nostrRelayPool, [{ url: 'wss://pool-a.example.com', rtt: 42 }, { url: 'wss://pool-b.example.com', rtt: 55 }])
	assertEquals(advert.listenNostrRelays, listen)
	const verified = await verifySignedAdvert(RENDEZVOUS, advert, 1234)
	assertEquals(verified?.nodeHash, local.nodeHash)
	assertEquals(verified?.relayPool, [{ url: 'wss://pool-a.example.com', rtt: 42 }, { url: 'wss://pool-b.example.com', rtt: 55 }])
	assertEquals(verified?.listenRelays, listen)
})

test('tampering with pool or listen invalidates signature', async () => {
	const local = identity(22)
	const advert = await buildSignedAdvert(RENDEZVOUS, 1234, {
		...local,
		nostrRelayPool: [{ url: 'wss://pool.example.com', rttMs: 42 }],
		listenNostrRelays: ['wss://listen.example.com'],
	})
	assertEquals(await verifySignedAdvert(RENDEZVOUS, { ...advert, nostrRelayPool: [{ url: 'wss://evil.example.com', rttMs: 42 }] }, 1234), null)
	assertEquals(await verifySignedAdvert(RENDEZVOUS, { ...advert, listenNostrRelays: ['wss://evil.example.com'] }, 1234), null)
	assertEquals((await verifySignedAdvert(RENDEZVOUS, advert, 1234))?.nodeHash, local.nodeHash)
})

test('sanitizeAdvertRelayFields trims invalid entries and caps sizes', () => {
	const pool = [
		{ url: 'http://bad.example.com', rttMs: 10 },
		{ url: 'wss://ok.example.com', rttMs: 10 },
		{ url: 'wss://dup.example.com', rttMs: 10 },
		{ url: 'wss://dup.example.com', rttMs: 20 },
		{ url: 'wss://highrtt.example.com', rttMs: MAX_RTT_MS + 1 },
	]
	const listen = ['ws://public.example.com', 'wss://good.example.com', 'wss://good.example.com']
	const result = sanitizeAdvertRelayFields(pool, listen)
	assertEquals(result.pool.length, 2, 'invalid + dup + high-rtt dropped')
	assertEquals(result.pool[0], { url: 'wss://ok.example.com', rtt: 10 })
	assertEquals(result.listen.length, 1, 'public ws + dup dropped')
	assertEquals(result.listen[0], 'wss://good.example.com')
})

test('sanitize caps pool/listen to limits', () => {
	const pool = Array.from({ length: MAX_ADVERT_RELAY_POOL + 10 }, (_, relayIndex) => ({ url: `wss://p${relayIndex}.example.com`, rttMs: 10 }))
	const listen = Array.from({ length: MAX_ADVERT_LISTEN_RELAYS + 10 }, (_, relayIndex) => `wss://l${relayIndex}.example.com`)
	const result = sanitizeAdvertRelayFields(pool, listen)
	assertEquals(result.pool.length, MAX_ADVERT_RELAY_POOL)
	assertEquals(result.listen.length, MAX_ADVERT_LISTEN_RELAYS)
})

test('sanitize emits audit log for dropped entries', async () => {
	const { messages, nodeDir } = await setupLogger()
	try {
		const result = sanitizeAdvertRelayFields([
			{ url: 'http://bad.example.com', rttMs: 10 },
			{ url: 'wss://badrtt.example.com', rttMs: 999999 },
		], ['ws://public.example.com'])
		assertEquals(result.pool.length, 0)
		assertEquals(result.listen.length, 0)
		const dropped = messages.filter(message => message.includes('invalidRelayUrl'))
		assert(dropped.length >= 3, `expected audit entries, got ${dropped.length}`)
	}
	finally {
		setConnectivityDebug(false)
		setNodeLogger(null)
		await teardownTestNodeDir(nodeDir)
	}
})

test('canonicalAdvertRelayBlob sorts deterministically and round-trips', async () => {
	const blobA = canonicalAdvertRelayBlob(
		[{ url: 'wss://b.example.com', rtt: 1 }, { url: 'wss://a.example.com', rtt: 2 }],
		['wss://z.example.com', 'wss://a.example.com'],
	)
	const blobB = canonicalAdvertRelayBlob(
		[{ url: 'wss://a.example.com', rtt: 2 }, { url: 'wss://b.example.com', rtt: 1 }],
		['wss://a.example.com', 'wss://z.example.com'],
	)
	assertEquals(blobA, blobB, 'order-independent')
	assert(blobA.length > 0)
	const parsed = JSON.parse(Buffer.from(blobA, 'hex').toString('utf8'))
	assertEquals(parsed.l[0], 'wss://a.example.com')
})
