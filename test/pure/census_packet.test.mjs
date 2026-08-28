import { test } from 'node:test'

import {
	buildCensusPacketFromSeed,
	NOSTR_CENSUS_KIND,
	verifyCensusBytes,
	verifyCensusPacket,
} from '../../discovery/nostr/census.mjs'
import { ensureNodeSeed, getNodeHash } from '../../node/identity.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

/**
 * 临时节点目录内执行测试（census 包用节点身份签名）。
 * @param {(dir: string) => Promise<void>} testFn 测试函数
 * @returns {Promise<void>}
 */
async function withTempNodeDir(testFn) {
	const dir = await mkTestNodeDir('census-packet-')
	initTestP2pNode({ nodeDir: dir })
	try {
		await testFn(dir)
	}
	finally {
		await teardownTestNodeDir(dir)
	}
}

/** 用当前节点 seed 构建签名 census 包。 */
const buildLocalCensusPacket = (p, ts) => buildCensusPacketFromSeed(ensureNodeSeed(), { p, ts })

test('census kind is outside advert/signal ranges', () => {
	assertEquals(NOSTR_CENSUS_KIND, 30789)
})

test('build then verify roundtrip succeeds', async () => {
	await withTempNodeDir(async () => {
		const nodeHash = getNodeHash()
		const ts = Date.now()
		const packet = await buildLocalCensusPacket(0.1, ts)
		assertEquals(packet.nodeHash, nodeHash)
		const verified = await verifyCensusPacket(packet, ts, 10 * 60_000)
		assertEquals(verified, { nodeHash, p: 0.1, ts })
	})
})

test('verify rejects tampered payloads', async () => {
	await withTempNodeDir(async () => {
		const nodeHash = getNodeHash()
		const ts = Date.now()
		const packet = await buildLocalCensusPacket(0.1, ts)

		assertEquals(await verifyCensusPacket({ ...packet, p: 0.2 }, ts), null)
		assertEquals(await verifyCensusPacket({ ...packet, ts: ts + 1 }, ts), null)
		assertEquals(await verifyCensusPacket({ ...packet, nodeHash: 'f'.repeat(64) }, ts), null)
		const tampered = { ...packet, sig: packet.sig.slice(0, -1) + (packet.sig.endsWith('0') ? '1' : '0') }
		assertEquals(await verifyCensusPacket(tampered, ts), null)
	})
})

test('verify rejects invalid shapes and out-of-window ts', async () => {
	await withTempNodeDir(async () => {
		const nodeHash = getNodeHash()
		const ts = Date.now()
		const packet = await buildLocalCensusPacket(0.1, ts)

		assertEquals(await verifyCensusPacket(packet, ts + 11 * 60_000, 10 * 60_000), null)
		assertEquals(await verifyCensusPacket({ ...packet, p: 0 }, ts), null)
		assertEquals(await verifyCensusPacket({ ...packet, p: 2 }, ts), null)
		assertEquals(await verifyCensusPacket({ ...packet, p: 'x' }, ts), null)
		assertEquals(await verifyCensusPacket({ ...packet, sig: 'zz' }, ts), null)
		assertEquals(await verifyCensusPacket({ ...packet, nodePubKey: 'nope' }, ts), null)
		assertEquals(await verifyCensusPacket(null, ts), null)
		assertEquals(await verifyCensusPacket(undefined, ts), null)
	})
})

test('verifyCensusBytes decodes base64 content', async () => {
	await withTempNodeDir(async () => {
		const nodeHash = getNodeHash()
		const ts = Date.now()
		const packet = await buildLocalCensusPacket(0.1, ts)
		const content = Buffer.from(JSON.stringify(packet), 'utf8').toString('base64')
		const verified = await verifyCensusBytes(Buffer.from(content, 'base64'), ts)
		assertEquals(verified, { nodeHash, p: 0.1, ts })
	})
})

test('verifyCensusBytes rejects garbage', async () => {
	assertEquals(await verifyCensusBytes(new Uint8Array([1, 2, 3])), null)
	assertEquals(await verifyCensusBytes(Buffer.from('not json', 'utf8')), null)
})