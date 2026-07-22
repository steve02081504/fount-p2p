import { randomBytes } from 'node:crypto'

import { normalizeHex64 } from '../core/hexIds.mjs'
import { decryptNodeSignalPacket, sendNodeSignalPacket } from '../discovery/index.mjs'
import { listLinkProviders } from '../link/providers/index.mjs'
import { nodeDebug, shortHash } from '../node/log.mjs'

/** accept/dial 挂起期间 ICE 信令 backlog 上限 */
const SIGNAL_BACKLOG_MAX = 64

/**
 * @param {(message: unknown) => Promise<void>} sendRemote 远端发送回调
 * @returns {object} 信令会话
 */
export function createBufferedSignalSession(sendRemote) {
	/** @type {Set<(message: unknown) => void>} */
	const handlers = new Set()
	/** @type {unknown[]} */
	const backlog = []
	return {
		/**
		 * @param {unknown} message 待发送信令消息
		 * @returns {Promise<void>}
		 */
		async send(message) {
			await sendRemote(message)
		},
		/**
		 * @param {(message: unknown) => void} handler 远端消息回调
		 * @returns {() => void} 取消订阅
		 */
		onRemote(handler) {
			handlers.add(handler)
			for (const pending of backlog.splice(0))
				handler(pending)
			return () => handlers.delete(handler)
		},
		/**
		 * @param {unknown} message 入站信令消息
		 * @returns {void}
		 */
		deliver(message) {
			if (!handlers.size) {
				if (backlog.length >= SIGNAL_BACKLOG_MAX) backlog.shift()
				backlog.push(message)
				return
			}
			for (const handler of handlers)
				handler(message)
		},
		/**
		 * @returns {void}
		 */
		clear() {
			backlog.length = 0
			handlers.clear()
		},
	}
}

/**
 * @param {unknown} body 信令 body
 * @returns {boolean} 是否为 WebRTC offer description
 */
function isOfferSignalBody(body) {
	return !!body && typeof body === 'object'
		&& body.type === 'description'
		&& body.description?.type === 'offer'
}

/**
 * @returns {import('../link/providers/index.mjs').LinkProvider | null} 首个需要 offer/answer 的 provider
 */
export function findOfferAnswerProvider() {
	return listLinkProviders().find(provider => provider.caps?.needsOfferAnswer) ?? null
}

/**
 * @param {object} deps 依赖
 * @returns {object} offer/answer 拨号
 */
export function createOfferAnswerDial(deps) {
	const {
		localIdentity,
		signalSessions,
		registerResolvedLink,
		trimToBudget,
		getCanonicalLink,
	} = deps

	/**
	 * @param {string} remoteNodeHash 远端
	 * @param {string} connId 连接 id
	 * @returns {ReturnType<typeof createBufferedSignalSession>} 该连接的缓冲信令会话
	 */
	function createConnSession(remoteNodeHash, connId) {
		const normalized = normalizeHex64(remoteNodeHash)
		return createBufferedSignalSession(async message => {
			await sendNodeSignalPacket(normalized, {
				type: 'signal',
				from: localIdentity.nodeHash,
				connId,
				body: message,
			})
		})
	}

	/**
	 * @param {object} options 建链参数
	 * @param {import('../link/providers/index.mjs').LinkProvider} options.provider 链路提供者
	 * @param {string} options.remoteNodeHash 远端 nodeHash
	 * @param {string} options.connId 连接 id
	 * @param {ReturnType<typeof createBufferedSignalSession>} options.session 信令会话
	 * @param {boolean} options.initiator 是否主动拨号
	 * @returns {Promise<object | null>} 建链成功返回规范链路，否则 null
	 */
	async function buildConnLink({ provider, remoteNodeHash, connId, session, initiator }) {
		try {
			if (initiator) await trimToBudget()
			const link = await (initiator ? provider.dial : provider.accept)({
				nodeHash: remoteNodeHash,
				signal: session,
				iceServers: deps.iceServers,
				localIdentity,
			})
			if (!link) {
				signalSessions.delete(connId)
				nodeDebug('p2p:webrtc null', {
					peer: shortHash(remoteNodeHash),
					provider: provider.id,
					role: initiator ? 'dial' : 'accept',
				})
				return null
			}
			link.onDown(() => signalSessions.delete(connId))
			await link.ready
			await registerResolvedLink(remoteNodeHash, link)
			return getCanonicalLink(remoteNodeHash) ?? null
		}
		catch (error) {
			signalSessions.delete(connId)
			nodeDebug('p2p:webrtc fail', {
				peer: shortHash(remoteNodeHash),
				provider: provider.id,
				role: initiator ? 'dial' : 'accept',
				err: String(error?.message || error),
			})
			return null
		}
	}

	/**
	 * @param {Uint8Array} bytes 加密信令
	 * @returns {Promise<void>}
	 */
	async function handleIncomingSignal(bytes) {
		const packet = decryptNodeSignalPacket(localIdentity.nodeHash, bytes)
		if (packet?.type !== 'signal') return
		const remoteNodeHash = normalizeHex64(packet.from)
		const connId = String(packet.connId || '')
		if (!remoteNodeHash || remoteNodeHash === localIdentity.nodeHash || !connId) return
		let session = signalSessions.get(connId)
		if (!session) {
			if (!isOfferSignalBody(packet.body)) return
			const provider = findOfferAnswerProvider()
			if (!provider) return
			nodeDebug('p2p:webrtc inbound offer', {
				peer: shortHash(remoteNodeHash),
				provider: provider.id,
			})
			session = createConnSession(remoteNodeHash, connId)
			signalSessions.set(connId, session)
			void buildConnLink({ provider, remoteNodeHash, connId, session, initiator: false })
		}
		session.deliver(packet.body)
	}

	/**
	 * @param {import('../link/providers/index.mjs').LinkProvider} provider 链路提供者
	 * @param {string} remoteNodeHash 远端 nodeHash
	 * @returns {Promise<object | null>} 建链成功返回规范链路，否则 null
	 */
	async function dialOfferAnswer(provider, remoteNodeHash) {
		const connId = randomBytes(16).toString('hex')
		const session = createConnSession(remoteNodeHash, connId)
		signalSessions.set(connId, session)
		return await buildConnLink({ provider, remoteNodeHash, connId, session, initiator: true })
	}

	return { handleIncomingSignal, dialOfferAnswer }
}
