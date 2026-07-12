import { strict as assert } from 'node:assert'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { encodeEntityHash } from '../../core/entity_id.mjs'
import { pubKeyHash, publicKeyFromSeed } from '../../crypto/crypto.mjs'
import { canonicalizeSignedRow } from '../../dag/canonicalize_row.mjs'
import { signTimelineEvent } from '../../timeline/append_core.mjs'
import { fountSkipReason, importFountP2pScript, importSocialModule } from '../helpers/fount_paths.mjs'

const skip = await fountSkipReason()
const namespace = skip ? null : await importSocialModule('federation/namespace.mjs')
const remoteIngest = skip ? null : await importSocialModule('federation/remote_ingest.mjs')
const fountP2pNode = skip ? null : await importFountP2pScript('node/instance.mjs')

/** Social 时间线 canonicalize 选项（测试内联） */
const SOCIAL_TIMELINE_ROW_OPTS = {
	contentHexKeys: new Set([
		'targetPostId',
		'targetId',
	]),
	entityHashKeys: new Set([
		'targetEntityHash',
	]),
}

/**
 * @param {object} event 签名事件
 * @returns {object} 规范化后的事件
 */
function canonicalizeTimelineRow(event) {
	return canonicalizeSignedRow(event, SOCIAL_TIMELINE_ROW_OPTS)
}

/**
 * @param {number} seedByte node.json 种子字节
 * @returns {Promise<string>} 临时 node 目录
 */
async function initTestNode(seedByte) {
	const dir = await mkdtemp(join(tmpdir(), 'fount-timeline-ingest-'))
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'node.json'), JSON.stringify({ nodeSeedHex: Buffer.alloc(32, seedByte).toString('hex') }))
	await writeFile(join(dir, 'denylist.json'), JSON.stringify({ blocked: [] }))
	fountP2pNode.initNode({ nodeDir: dir })
	return dir
}

test('validateRemoteTimelineEvent rejects wrong groupId', { skip }, async () => {
	const dir = await initTestNode(1)
	try {
		const owner = 'a'.repeat(64) + 'b'.repeat(64)
		const result = await remoteIngest.validateRemoteTimelineEvent({
			type: 'post',
			groupId: 'social-timeline:' + 'c'.repeat(128),
			sender: 'd'.repeat(64),
			id: 'e'.repeat(64),
		}, owner, { canonicalize: canonicalizeTimelineRow })
		assert.equal(result.accepted, false)
	}
	finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('validateRemoteTimelineEvent rejects unknown event type', { skip }, async () => {
	const dir = await initTestNode(2)
	try {
		const owner = 'a'.repeat(64) + 'b'.repeat(64)
		const result = await remoteIngest.validateRemoteTimelineEvent({
			type: 'message',
			groupId: namespace.timelineGroupId(owner),
			sender: 'd'.repeat(64),
			id: 'e'.repeat(64),
		}, owner, { canonicalize: canonicalizeTimelineRow })
		assert.equal(result.accepted, false)
	}
	finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('validateRemoteTimelineEvent accepts signed owner post with production canonicalize', { skip }, async () => {
	const dir = await initTestNode(9)
	try {
		const secretKey = Buffer.alloc(32, 9)
		const sender = pubKeyHash(publicKeyFromSeed(secretKey))
		const owner = encodeEntityHash('c'.repeat(64), sender)
		const event = await signTimelineEvent({
			type: 'post',
			groupId: namespace.timelineGroupId(owner),
			sender,
			timestamp: 1_700_000_000_000,
			hlc: { wall: 1_700_000_000_000, counter: 0, node: sender.slice(0, 8) },
			prev_event_ids: [],
			content: { text: 'hello', visibility: 'public' },
			node_id: 'remote-test',
		}, secretKey)
		const result = await remoteIngest.validateRemoteTimelineEvent(event, owner, { canonicalize: canonicalizeTimelineRow })
		assert.equal(result.accepted, true)
		assert.equal(result.row.id, event.id)
		assert.equal(result.row.sender, sender)
	}
	finally {
		await rm(dir, { recursive: true, force: true })
	}
})
