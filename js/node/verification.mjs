import { randomBytes } from 'node:crypto'

import { isHex64 } from '../core/hexIds.mjs'
import { sendToNodeLink } from '../transport/link_registry.mjs'
import { attachNodeScopeFeature } from '../transport/node_scope/features.mjs'

import { getNodeHash } from './identity.mjs'

const MAX_TIMEOUT = 30 * 60 * 1000

/**
 * @typedef {{ challenge: string, requesterNodeHash: string, expiresAt: number }} NetworkChallenge 挑战
 */

/**
 * 创建有界的挑战服务；发送方身份一律取自已认证的网络入口，不信任载荷自称。
 * @param {{nodeHash: string, send: (peer: string, action: string, payload: object) => Promise<boolean>, now?: () => number}} options 依赖
 * @returns {object} 挑战服务
 */
export function createNetworkVerificationService({ nodeHash, send, now = Date.now }) {
	const requests = new Map()
	const proofs = new Map()
	/**
	 * 清理已过期的挑战记录。
	 * @returns {void} 无返回值
	 */
	function prune() {
		for (const [id, entry] of requests) if (entry.expiresAt + 60000 < now()) requests.delete(id)
	}
	/**
	 * 取挑战快照，并把已过期的 pending 收敛为 failed。
	 * @param {object} entry 挑战状态
	 * @returns {object} 快照
	 */
	function snapshot(entry) {
		if (entry.status === 'pending' && now() >= entry.expiresAt) entry.status = 'failed', entry.reason = 'timeout'
		return { ...entry }
	}
	return {
		/**
		 * 新建一个挑战：限幅超时、限制在途数量，返回待验证快照。
		 * @param {{ timeoutMs?: number }} [options] 超时选项
		 * @returns {object} 待验证快照
		 */
		create({ timeoutMs = 300000 } = {}) {
			if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) throw new Error('invalid timeoutMs')
			prune()
			if (requests.size >= 1024) throw new Error('too many verification requests')
			const challenge = randomBytes(32).toString('hex')
			const entry = { challenge, requesterNodeHash: nodeHash, expiresAt: now() + timeoutMs, status: 'pending' }
			requests.set(challenge, entry)
			return snapshot(entry)
		},
		/**
		 * 按挑战串读取快照；不存在返回 null。
		 * @param {string} challenge 挑战串
		 * @returns {object|null} 快照
		 */
		get(challenge) {
			prune()
			const entry = requests.get(challenge)
			return entry ? snapshot(entry) : null
		},
		/**
		 * 处理入站 verification_claim / verification_receipt 动作。
		 * @param {string} action 网络动作
		 * @param {object} payload 网络载荷
		 * @param {string} sender 已认证身份
		 */
		async receive(action, payload, sender) {
			if (!isHex64(sender) || !isHex64(payload?.challenge)) return
			if (action === 'verification_claim') {
				const entry = requests.get(payload.challenge)
				if (!entry || now() >= entry.expiresAt || snapshot(entry).status === 'failed' || entry.expiresAt !== payload.expiresAt) return
				if (entry.status === 'verified' && entry.nodeHash !== sender) return
				entry.status = 'verified'
				entry.nodeHash = sender
				await send(sender, 'verification_receipt', { challenge: entry.challenge, expiresAt: entry.expiresAt })
			}
			if (action === 'verification_receipt') {
				const proof = proofs.get(payload.challenge)
				if (proof && proof.requesterNodeHash === sender && proof.expiresAt === payload.expiresAt && now() < proof.expiresAt)
					proof.resolve({ status: 'verified', nodeHash })
			}
		},
		/**
		 * 向请求方发起验证并等待回执（去重、并发上限、超时收敛为 failed）。
		 * @param {NetworkChallenge} request 挑战请求
		 * @returns {Promise<object>} 验证结果
		 */
		async prove({ requesterNodeHash, challenge, expiresAt }) {
			if (!isHex64(requesterNodeHash) || !isHex64(challenge) || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + MAX_TIMEOUT)
				return { status: 'failed', reason: 'invalid challenge' }
			if (proofs.has(challenge)) {
				const existing = proofs.get(challenge)
				if (existing.requesterNodeHash !== requesterNodeHash || existing.expiresAt !== expiresAt) return { status: 'failed', reason: 'challenge mismatch' }
				return existing.promise
			}
			if (proofs.size >= 64) return { status: 'failed', reason: 'busy' }
			let resolve
			const promise = new Promise(done => { resolve = done })
			proofs.set(challenge, { requesterNodeHash, expiresAt, resolve, promise })
			const timer = setTimeout(() => resolve({ status: 'failed', reason: 'timeout' }), Math.min(expiresAt - now(), 15000))
			try {
				void send(requesterNodeHash, 'verification_claim', { challenge, expiresAt }).then(sent => {
					if (!sent) resolve({ status: 'failed', reason: 'unreachable' })
				}, () => resolve({ status: 'failed', reason: 'unreachable' }))
				return await promise
			}
			finally { clearTimeout(timer); proofs.delete(challenge) }
		},
	}
}

let service
/**
 * 把验证动作挂到正在运行的节点的 node scope 上。
 * @returns {() => void} 卸载 dispose
 */
export function attachNetworkVerification() {
	return attachNodeScopeFeature('verification', wire => {
		const current = getNetworkVerificationService()
		const disposers = ['verification_claim', 'verification_receipt'].map(action => wire.on(action, (payload, sender) => {
			void current.receive(action, payload, sender).catch(() => {})
		}))
		return () => { for (const dispose of disposers) dispose(); service = null }
	})
}

/**
 * 取当前节点的验证服务（懒创建单例）。
 * @returns {ReturnType<typeof createNetworkVerificationService>} 验证服务
 */
export function getNetworkVerificationService() {
	if (!service) service = createNetworkVerificationService({ nodeHash: getNodeHash(), send: sendVerificationEnvelope })
	return service
}

/**
 * 经已认证链路投递验证消息；请求方就是本节点时直接走本地入口。
 * @param {string} peer 目标身份
 * @param {string} action 网络动作
 * @param {object} payload 网络载荷
 * @returns {Promise<boolean>} 是否已投递
 */
async function sendVerificationEnvelope(peer, action, payload) {
	if (peer === getNodeHash()) {
		await getNetworkVerificationService().receive(action, payload, peer)
		return true
	}
	return await sendToNodeLink(peer, { scope: 'node', action, payload })
}

/**
 * 单次自证：证明本节点可达请求方并收到其回执。
 * @param {NetworkChallenge} request 挑战请求
 * @returns {Promise<object>} 验证结果
 */
export async function proveNetworkVerification(request) {
	const dispose = attachNetworkVerification()
	try { return await getNetworkVerificationService().prove(request) }
	finally { dispose() }
}
