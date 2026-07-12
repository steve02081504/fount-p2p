import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
	entriesForTargetEntityHash,
	isAuthorFilteredByPersonalSets,
	matchesPersonalListEntries,
	normalizePersonalListEntries,
} from '../../node/personal_block.mjs'
import { fountSkipReason, importSocialModule } from '../helpers/fount_paths.mjs'

const socialSkip = await fountSkipReason()
const socialReducers = socialSkip ? null : await importSocialModule('timeline/reducers.mjs')
const reputationSocial = socialSkip ? null : await importSocialModule('federation/reputation_social.mjs')

const NODE_A = 'a'.repeat(64)
const NODE_B = 'b'.repeat(64)
const SUBJ_C = 'c'.repeat(64)
const SUBJ_D = 'd'.repeat(64)
const USER_ENTITY = NODE_A + SUBJ_C
const AGENT_ENTITY = NODE_B + SUBJ_D

test('entriesForTargetEntityHash includes entity and subject', () => {
	const entries = entriesForTargetEntityHash(USER_ENTITY)
	assert.equal(entries.length, 2)
	assert.equal(entries.some(e => e.scope === 'entity' && e.value === USER_ENTITY), true)
	assert.equal(entries.some(e => e.scope === 'subject' && e.value === SUBJ_C), true)
})

test('matchesPersonalListEntries blocks by subject across nodes', () => {
	const entries = normalizePersonalListEntries([{ scope: 'subject', value: SUBJ_C }])
	const otherNodeEntity = 'f'.repeat(64) + SUBJ_C
	assert.equal(matchesPersonalListEntries(entries, { entityHash: otherNodeEntity }), true)
})

test('isAuthorFilteredByPersonalSets uses entity and subject sets', () => {
	const filterSets = {
		blockedEntityHashes: new Set([AGENT_ENTITY]),
		blockedSubjects: new Set(),
		hiddenEntityHashes: new Set(),
		hiddenSubjects: new Set(),
	}
	assert.equal(isAuthorFilteredByPersonalSets(filterSets, AGENT_ENTITY), true)
	assert.equal(isAuthorFilteredByPersonalSets(filterSets, USER_ENTITY), false)
})

test('social reducer block and unblock materialize blocked list', { skip: socialSkip }, () => {
	let state = socialReducers.createSocialTimelineState()
	state = socialReducers.SOCIAL_TIMELINE_REDUCERS.block(state, {
		content: { targetEntityHash: USER_ENTITY },
	})
	state = socialReducers.SOCIAL_TIMELINE_REDUCERS.unblock(state, {
		content: { targetEntityHash: AGENT_ENTITY },
	})
	state = socialReducers.SOCIAL_TIMELINE_REDUCERS.block(state, {
		content: { targetEntityHash: AGENT_ENTITY },
	})
	const view = socialReducers.finalizeSocialTimelineView(state, ['e1'])
	assert.deepEqual(view.blocked, [USER_ENTITY, AGENT_ENTITY])
})

test('applyFollowedBlockSignal selfTrust penalizes target node and unblocks symmetrically', { skip: socialSkip }, async () => {
	/** @type {import('../../node/reputation_store.mjs').ReputationFile} */
	const data = { byNodeHash: {}, wantUnknownHits: [], relayBumpSeen: [] }
	/**
	 * 在可变信誉数据上执行 social 层变更回调。
	 * @param {(data: import('../../node/reputation_store.mjs').ReputationFile) => void | Promise<void>} fn 变更函数
	 * @returns {Promise<void>}
	 */
	const mutate = async fn => {
		await fn(data)
	}
	await reputationSocial.applyFollowedBlockSignal({
		followerEntityHash: USER_ENTITY,
		targetEntityHash: AGENT_ENTITY,
		action: 'block',
		selfTrust: true,
	}, mutate)
	assert.equal(Number(data.byNodeHash[NODE_B]?.score ?? 0) < 0, true)
	const penalty = data.byNodeHash[NODE_B].blockPenalties?.[USER_ENTITY]?.penalty
	assert.equal(typeof penalty, 'number')
	await reputationSocial.applyFollowedBlockSignal({
		followerEntityHash: USER_ENTITY,
		targetEntityHash: AGENT_ENTITY,
		action: 'unblock',
		selfTrust: true,
	}, mutate)
	assert.equal(data.byNodeHash[NODE_B]?.score ?? 0, 0)
	assert.equal(data.byNodeHash[NODE_B]?.blockPenalties?.[USER_ENTITY], undefined)
})

test('applyFollowedBlockSignal dedupes repeated block from same follower', { skip: socialSkip }, async () => {
	/** @type {import('../../node/reputation_store.mjs').ReputationFile} */
	const data = {
		byNodeHash: { [NODE_A]: { score: 0.8 } },
		wantUnknownHits: [],
		relayBumpSeen: [],
	}
	/**
	 * 在可变信誉数据上执行 social 层变更回调。
	 * @param {(data: import('../../node/reputation_store.mjs').ReputationFile) => void | Promise<void>} fn 变更函数
	 * @returns {Promise<void>}
	 */
	const mutate = async fn => {
		await fn(data)
	}
	await reputationSocial.applyFollowedBlockSignal({
		followerEntityHash: USER_ENTITY,
		targetEntityHash: AGENT_ENTITY,
		action: 'block',
		selfTrust: false,
	}, mutate)
	const first = data.byNodeHash[NODE_B].score
	await reputationSocial.applyFollowedBlockSignal({
		followerEntityHash: USER_ENTITY,
		targetEntityHash: AGENT_ENTITY,
		action: 'block',
		selfTrust: false,
	}, mutate)
	assert.equal(data.byNodeHash[NODE_B].score, first)
})
