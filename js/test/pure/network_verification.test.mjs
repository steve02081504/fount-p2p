import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { configureNodeStorage, closeNode } from '../../node/instance.mjs'
import { attachNetworkVerification, proveNetworkVerification, getNetworkVerificationService, createNetworkVerificationService } from '../../node/verification.mjs'
import { assert, assertThrows } from '../helpers/assert.mjs'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

test('network verification needs authenticated claim and requester receipt', async () => {
	/**
	 * a 的出站投递：断言目标确实是对端 b，再把载荷转交给它。
	 * @param {string} peer 目标节点 hash
	 * @param {string} action 动作名
	 * @param {object} payload 载荷
	 * @returns {Promise<boolean>} b 是否受理
	 */
	const sendFromA = async (peer, action, payload) => {
		assert.equal(peer, B)
		await b.receive(action, payload, A)
		return true
	}
	/**
	 * b 的出站投递：断言目标确实是对端 a，再把载荷转交给它。
	 * @param {string} peer 目标节点 hash
	 * @param {string} action 动作名
	 * @param {object} payload 载荷
	 * @returns {Promise<boolean>} a 是否受理
	 */
	const sendFromB = async (peer, action, payload) => {
		assert.equal(peer, A)
		await a.receive(action, payload, B)
		return true
	}
	const a = createNetworkVerificationService({ nodeHash: A, send: sendFromA })
	const b = createNetworkVerificationService({ nodeHash: B, send: sendFromB })
	const challenge = a.create()
	assert.equal(a.get(challenge.challenge).status, 'pending')
	assert.deepEqual(await b.prove(challenge), { status: 'verified', nodeHash: B })
	assert.equal(a.get(challenge.challenge).nodeHash, B)
	await a.receive('verification_claim', challenge, C)
	assert.equal(a.get(challenge.challenge).nodeHash, B)
})

test('wrong secret, wrong deadline and expired claims cannot verify', async () => {
	let now = 1000
	const a = createNetworkVerificationService({ nodeHash: A,
		/**
		 * 用可控时间源，才能在测试里跨过 expiresAt。
		 * @returns {number} 当前毫秒时间戳
		 */
		now: () => now,
		/**
		 * 只回「送达」，本用例只关心 claim 的过期判定。
		 * @returns {Promise<boolean>} 恒为 true
		 */
		send: async () => true })
	const challenge = a.create({ timeoutMs: 100 })
	await a.receive('verification_claim', { ...challenge, challenge: C }, B)
	await a.receive('verification_claim', { ...challenge, expiresAt: 1101 }, B)
	assert.equal(a.get(challenge.challenge).status, 'pending')
	now = 1100
	await a.receive('verification_claim', challenge, B)
	assert.equal(a.get(challenge.challenge).status, 'failed')
	assert.equal(a.get(challenge.challenge).reason, 'timeout')
})

test('unreachable nodes and invalid challenge fail explicitly', async () => {
	const a = createNetworkVerificationService({ nodeHash: A,
		/**
		 * 模拟对端不可达：信封发不出去。
		 * @returns {Promise<boolean>} 恒为 false
		 */
		send: async () => false })
	const b = createNetworkVerificationService({ nodeHash: B,
		/**
		 * 模拟对端不可达：信封发不出去。
		 * @returns {Promise<boolean>} 恒为 false
		 */
		send: async () => false })
	assert.equal((await b.prove(a.create())).reason, 'unreachable')
	assert.equal((await b.prove({ requesterNodeHash: A, challenge: C, expiresAt: 0 })).reason, 'invalid challenge')
	assertThrows(() => a.create({ timeoutMs: Infinity }))
})

test('temporary attachments preserve permanent requester challenges', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'verification-'))
	let permanent
	try {
		configureNodeStorage({ nodeDir: dir })
		permanent = attachNetworkVerification()
		const current = getNetworkVerificationService()
		const challenge = current.create()
		for (let i = 0; i < 3; i++) {
			const temporary = attachNetworkVerification()
			temporary()
			assert.equal(getNetworkVerificationService(), current)
			assert.equal(current.get(challenge.challenge).status, 'pending')
			assert.equal((await proveNetworkVerification(current.create())).status, 'verified')
			assert.equal(getNetworkVerificationService(), current)
		}
	}
	finally { permanent?.(); await closeNode(); rmSync(dir, { recursive: true, force: true }) }
})
