import { randomBytes } from 'node:crypto'

import { normalizeHex64 } from '../core/hexIds.mjs'
import { sendSignal } from '../discovery/index.mjs'
import { listLinkProviders } from '../link/providers/index.mjs'

import { decryptSignalPacket, encryptSignalPacket, nodeRendezvousTopic } from './signal_crypto.mjs'

/** accept/dial 挂起期间 ICE 信令 backlog 上限，防无 handler 时无限堆积 */
const SIGNAL_BACKLOG_MAX = 64

/**
 * 创建带 backlog 的缓冲信令会话。
 * @param {(message: unknown) => Promise<void>} sendRemote 远端发送回调
 * @returns {{ send: (message: unknown) => Promise<void>, onRemote: (handler: (message: unknown) => void) => () => void, deliver: (message: unknown) => void, clear: () => void }} 信令会话
 */
export function createBufferedSignalSession(sendRemote) {
	/** @type {Set<(message: unknown) => void>} */
	const handlers = new Set()
	/** @type {unknown[]} */
	const backlog = []
	return {
		/**
		 * 发送信令消息到远端。
		 * @param {unknown} message 信令消息
		 * @returns {Promise<void>}
		 */
		async send(message) {
			await sendRemote(message)
		},
		/**
		 * 注册远端信令 handler（含 backlog 回放）。
		 * @param {(message: unknown) => void} handler 入站回调
		 * @returns {() => void} 取消订阅函数
		 */
		onRemote(handler) {
			handlers.add(handler)
			for (const pending of backlog.splice(0))
				handler(pending)
			return () => handlers.delete(handler)
		},
		/**
		 * 投递信令消息；无 handler 时入 backlog（有界）。
		 * @param {unknown} message 信令消息
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
		 * 清空 backlog 与 handler。
		 * @returns {void}
		 */
		clear() {
			backlog.length = 0
			handlers.clear()
		},
	}
}

/**
 * 判断信令 body 是否为发起方 offer（据此决定入站是否新建应答 PC）。
 * @param {unknown} body 信令 body
 * @returns {boolean} 是 offer 则 true
 */
function isOfferSignalBody(body) {
	return !!body && typeof body === 'object'
		&& body.type === 'description'
		&& body.description?.type === 'offer'
}

/**
 * 找已注册的 offer/answer provider（按 level 降序的第一个）。
 * @returns {import('../link/providers/index.mjs').LinkProvider | null} 命中的 provider；无则 null
 */
export function findOfferAnswerProvider() {
	return listLinkProviders().find(provider => provider.caps?.needsOfferAnswer) ?? null
}

/**
 * Offer/answer glare 拨号控制器（WebRTC 等 needsOfferAnswer provider）。
 * @param {object} deps 依赖注入
 * @param {{ nodeHash: string, nodePubKey: string, secretKey: Uint8Array }} deps.localIdentity 本地身份
 * @param {RTCConfiguration['iceServers']} deps.iceServers ICE 服务器列表
 * @param {string} deps.selfTopic 本机 rendezvous topic
 * @param {Map<string, ReturnType<typeof createBufferedSignalSession>>} deps.signalSessions 按 connId 索引的信令会话
 * @param {(remoteNodeHash: string, link: object) => Promise<void>} deps.registerResolvedLink 注册规范链
 * @param {() => Promise<void>} deps.trimToBudget 超预算驱逐
 * @param {(remoteNodeHash: string) => object | null | undefined} deps.getCanonicalLink 读取当前规范链
 * @returns {{ handleIncomingSignal: (bytes: Uint8Array) => Promise<void>, dialOfferAnswer: (provider: import('../link/providers/index.mjs').LinkProvider, remoteNodeHash: string) => Promise<object | null> }} 入站信令与主动拨号
 */
export function createOfferAnswerDial(deps) {
	const {
		localIdentity,
		iceServers,
		selfTopic,
		signalSessions,
		registerResolvedLink,
		trimToBudget,
		getCanonicalLink,
	} = deps

	/**
	 * 为单条 PC 创建按 connId 标记的信令会话。
	 * @param {string} remoteNodeHash 远端节点 64 hex
	 * @param {string} connId 连接标识
	 * @returns {ReturnType<typeof createBufferedSignalSession>} 信令会话
	 */
	function createConnSession(remoteNodeHash, connId) {
		const normalized = normalizeHex64(remoteNodeHash)
		const topic = nodeRendezvousTopic(normalized)
		return createBufferedSignalSession(async message => {
			await sendSignal(topic, normalized, encryptSignalPacket(topic, {
				type: 'signal',
				from: localIdentity.nodeHash,
				connId,
				body: message,
			}))
		})
	}

	/**
	 * Offer/answer provider：为一条 connId 会话建链并走 glare 择一。
	 * @param {{ provider: import('../link/providers/index.mjs').LinkProvider, remoteNodeHash: string, connId: string, session: ReturnType<typeof createBufferedSignalSession>, initiator: boolean }} options 建链参数
	 * @returns {Promise<object | null>} 当前规范链；失败 null
	 */
	async function buildConnLink({ provider, remoteNodeHash, connId, session, initiator }) {
		try {
			if (initiator) await trimToBudget()
			const link = await (initiator ? provider.dial : provider.accept)({
				nodeHash: remoteNodeHash,
				signal: session,
				iceServers,
				localIdentity,
			})
			if (!link) {
				signalSessions.delete(connId)
				return null
			}
			link.onDown(() => signalSessions.delete(connId))
			await link.ready
			await registerResolvedLink(remoteNodeHash, link)
			return getCanonicalLink(remoteNodeHash) ?? null
		}
		catch {
			signalSessions.delete(connId)
			return null
		}
	}

	/**
	 * 处理入站加密信令并可能发起被动建链。
	 * @param {Uint8Array} bytes 加密信令字节
	 * @returns {Promise<void>}
	 */
	async function handleIncomingSignal(bytes) {
		const packet = decryptSignalPacket(selfTopic, bytes)
		if (packet?.type !== 'signal') return
		const remoteNodeHash = normalizeHex64(packet.from)
		const connId = String(packet.connId || '')
		if (!remoteNodeHash || remoteNodeHash === localIdentity.nodeHash || !connId) return
		let session = signalSessions.get(connId)
		if (!session) {
			if (!isOfferSignalBody(packet.body)) return
			const provider = findOfferAnswerProvider()
			if (!provider) return
			session = createConnSession(remoteNodeHash, connId)
			signalSessions.set(connId, session)
			void buildConnLink({ provider, remoteNodeHash, connId, session, initiator: false })
		}
		session.deliver(packet.body)
	}

	/**
	 * 经 offer/answer provider 拨号（discovery signal + glare）。
	 * @param {import('../link/providers/index.mjs').LinkProvider} provider 链路提供者
	 * @param {string} remoteNodeHash 远端 64 hex
	 * @returns {Promise<object | null>} 当前规范链；失败 null
	 */
	async function dialOfferAnswer(provider, remoteNodeHash) {
		const connId = randomBytes(16).toString('hex')
		const session = createConnSession(remoteNodeHash, connId)
		signalSessions.set(connId, session)
		return await buildConnLink({ provider, remoteNodeHash, connId, session, initiator: true })
	}

	return { handleIncomingSignal, dialOfferAnswer }
}
