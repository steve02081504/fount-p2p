import { normalizeHex64 } from '../core/hexIds.mjs'
import { ms } from '../utils/duration.mjs'
import { createLruMap } from '../utils/lru.mjs'

import { createReassembler, encodeFrames, randomMsgIdHex } from './frame.mjs'
import { buildAuth, buildHello, parseHello, verifyAuth } from './handshake.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * 依次调用监听器集合，忽略单个 listener 抛错。
 * @param {Set<Function>} listeners 监听器集合
 * @param {...unknown} args 传递给 listener 的参数
 * @returns {void}
 */
function emitListeners(listeners, ...args) {
	for (const listener of listeners)
		try { listener(...args) }
		catch { /* ignore */ }
}

/**
 * 原始字节：以 `{` 开头的 UTF-8 当 control 文本，否则当二进制帧。
 * @param {Buffer | Uint8Array | string} raw 原始数据
 * @returns {string | Uint8Array} control 文本或二进制帧
 */
export function coercePipeInbound(raw) {
	if (typeof raw === 'string') return raw
	const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw)
	try {
		const text = decoder.decode(bytes)
		if (text.startsWith('{')) return text
	}
	catch { /* binary */ }
	return bytes
}

/**
 * 把 createLinkPipe 句柄收成上层 LinkHandle（可附带测试/内部字段）。
 * @param {ReturnType<typeof createLinkPipe>} pipe pipe
 * @param {object} [extras] 附加字段（如 handleInbound、_channelForTest）
 * @returns {object} LinkHandle 形状
 */
export function asLinkHandle(pipe, extras = {}) {
	return {
		ready: pipe.ready,
		/** @returns {string | null} 对端 nodeHash */
		get nodeHash() { return pipe.nodeHash },
		/** @returns {boolean} 是否发起方 */
		get initiator() { return pipe.initiator },
		/** @returns {string} 提供者 id */
		get providerId() { return pipe.providerId },
		/** @returns {number} 提供者 level */
		get level() { return pipe.level },
		/**
		 * @param {...unknown} args send 参数
		 * @returns {Promise<boolean>} 是否发送成功
		 */
		send: (...args) => pipe.send(...args),
		/**
		 * @param {...unknown} args onEnvelope 参数
		 * @returns {() => void} 取消订阅
		 */
		onEnvelope: (...args) => pipe.onEnvelope(...args),
		/**
		 * @param {...unknown} args onDown 参数
		 * @returns {() => void} 取消订阅
		 */
		onDown: (...args) => pipe.onDown(...args),
		/**
		 * @param {...unknown} args close 参数
		 * @returns {Promise<void>}
		 */
		close: (...args) => pipe.close(...args),
		/** @returns {object} 运行时统计 */
		stats: () => pipe.stats(),
		...extras,
	}
}

/**
 * 在已打开的字节/控制双工上跑 hello/auth、分帧 envelope 与心跳。
 * @param {object} options pipe 配置
 * @param {string} options.providerId 提供者 id
 * @param {number} options.level 提供者 level
 * @param {boolean} options.initiator 是否发起方
 * @param {string | null} [options.nodeHash] 期望对端 nodeHash
 * @param {{ nodeHash?: string, nodePubKey?: string, secretKey?: Uint8Array, nonce?: string } | null} [options.localIdentity] 本地身份
 * @param {() => string | null} options.getLocalBinding 本地 binding（未就绪返回 null）
 * @param {() => string | null} options.getRemoteBinding 远端 binding（未就绪返回 null）
 * @param {(text: string) => void | Promise<void>} options.sendControlText 发送 control JSON 文本
 * @param {(action: string, frame: Uint8Array) => void | Promise<void>} options.sendFrame 发送分帧二进制
 * @param {() => void | Promise<void>} [options.closeTransport] 关闭底层传输
 * @param {() => object} [options.extraStats] 附加 stats 字段
 * @param {number} [options.heartbeatMs] 心跳间隔
 * @param {number} [options.idleTimeoutMs] 空闲超时
 * @param {number} [options.handshakeTimeoutMs] 握手超时
 * @returns {object} link 句柄 + 入站 API
 */
export function createLinkPipe(options) {
	const providerId = String(options.providerId || '')
	const level = Number(options.level) || 0
	const heartbeatMs = Number(options.heartbeatMs) || ms('15s')
	const idleTimeoutMs = Number(options.idleTimeoutMs) || ms('45s')
	const handshakeTimeoutMs = Number(options.handshakeTimeoutMs) || ms('10s')
	const targetNodeHash = normalizeHex64(options.nodeHash || '')
	let closed = false
	let ready = false
	let closeReason = 'closed'
	let remoteNodeHash = targetNodeHash || null
	let remoteHello = null
	let localHello = null
	let handshakeTimer = null
	let idleTimer = null
	let heartbeatTimer = null
	let helloSent = false
	let authSent = false
	let remoteAuthVerified = false
	/** @type {object | null} */
	let pendingAuth = null
	let lastInboundAt = Date.now()
	let lastOutboundAt = 0
	let sentFrames = 0
	let recvFrames = 0
	const envelopeListeners = new Set()
	const downListeners = new Set()
	const completedMsgIds = createLruMap(4096)
	const reassembler = createReassembler()
	/** @type {(value: void | PromiseLike<void>) => void} */
	let resolveReady
	/** @type {(reason?: unknown) => void} */
	let rejectReady
	const readyPromise = new Promise((resolve, reject) => {
		resolveReady = resolve
		rejectReady = reject
	})
	void readyPromise.catch(() => { })

	/**
	 * 经 control 发送 hello/auth JSON。
	 * @param {object} body hello 或 auth 字段
	 * @returns {Promise<void>}
	 */
	async function sendRawControl(body) {
		const text = JSON.stringify({ type: body.sig ? 'auth' : 'hello', ...body })
		await Promise.resolve(options.sendControlText(text))
		lastOutboundAt = Date.now()
	}

	/**
	 * binding 就绪后向对端发送 auth。
	 * @returns {Promise<void>}
	 */
	async function maybeSendAuth() {
		if (authSent || !remoteHello) return
		const binding = options.getLocalBinding()
		if (!binding) return
		authSent = true
		await sendRawControl(await buildAuth(remoteHello.nonce, binding, options.localIdentity ?? {}))
	}

	/**
	 * 握手完成后启动心跳并 resolve ready。
	 * @returns {Promise<void>}
	 */
	async function maybeFinishHandshake() {
		if (ready || !remoteHello || !remoteAuthVerified) return
		ready = true
		clearTimeout(handshakeTimer)
		heartbeatTimer = setInterval(() => {
			void send({ scope: 'link', action: 'ping', payload: {} }).catch(() => { })
		}, heartbeatMs)
		idleTimer = setInterval(() => {
			if (Date.now() - lastInboundAt > idleTimeoutMs)
				void close('idle-timeout')
		}, Math.max(1000, Math.floor(heartbeatMs / 3)))
		resolveReady()
	}

	/**
	 * 校验远端 auth。
	 * @param {{ sig: string }} auth auth 载荷
	 * @returns {Promise<void>}
	 */
	async function handleAuth(auth) {
		if (!remoteHello) {
			pendingAuth = auth
			return
		}
		const binding = options.getRemoteBinding()
		const verifiedNodeHash = await verifyAuth(remoteHello, auth, localHello?.nonce, binding)
		if (!verifiedNodeHash) {
			await close(`auth-failed:binding=${binding || 'missing'} localNonce=${localHello?.nonce || 'missing'}`)
			return
		}
		if (targetNodeHash && verifiedNodeHash !== targetNodeHash) {
			await close('nodehash-mismatch')
			return
		}
		remoteNodeHash = verifiedNodeHash
		remoteAuthVerified = true
		await maybeFinishHandshake()
	}

	/**
	 * 处理 control JSON（hello/auth）。
	 * @param {unknown} message 解析后的对象
	 * @returns {Promise<void>}
	 */
	async function handleControlMessage(message) {
		if (!message || typeof message !== 'object') return
		if (message.type === 'hello') {
			const parsed = parseHello(message)
			if (!parsed) {
				await close('hello-invalid')
				return
			}
			remoteHello = parsed
			await maybeSendAuth()
			if (pendingAuth) {
				const bufferedAuth = pendingAuth
				pendingAuth = null
				await handleAuth(bufferedAuth)
			}
			return
		}
		if (message.type === 'auth')
			await handleAuth(message)
	}

	/**
	 * 处理入站二进制帧。
	 * @param {Uint8Array} bytes 帧字节
	 * @returns {void}
	 */
	function handleBinaryFrame(bytes) {
		try {
			recvFrames++
			const merged = reassembler.push(bytes)
			if (!merged) return
			const envelope = JSON.parse(decoder.decode(merged))
			const msgId = envelope?.msgId ? String(envelope.msgId) : null
			if (msgId && completedMsgIds.has(msgId)) return
			if (msgId) completedMsgIds.touch(msgId, true)
			if (envelope?.scope === 'link') {
				if (envelope.action === 'ping') {
					void send({ scope: 'link', action: 'pong', payload: {} }).catch(() => { })
					return
				}
				if (envelope.action === 'pong') return
			}
			if (ready && remoteNodeHash)
				emitListeners(envelopeListeners, envelope, remoteNodeHash)
		}
		catch {
			/* drop malformed network ingress */
		}
	}

	/**
	 * 统一入站：JSON control 或二进制帧。
	 * @param {unknown} data 原始数据
	 * @returns {void}
	 */
	function handleInbound(data) {
		lastInboundAt = Date.now()
		if (typeof data === 'string') {
			if (data.startsWith('{'))
				try {
					void handleControlMessage(JSON.parse(data))
					return
				}
				catch { /* fall through */ }
			try {
				handleBinaryFrame(encoder.encode(data))
			}
			catch { /* ignore */ }
			return
		}
		if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Uint8Array) {
			const bytes = data instanceof Uint8Array
				? data
				: data instanceof ArrayBuffer
					? new Uint8Array(data)
					: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
			// 尝试 UTF-8 JSON control
			try {
				const text = decoder.decode(bytes)
				if (text.startsWith('{')) {
					void handleControlMessage(JSON.parse(text))
					return
				}
			}
			catch { /* binary path */ }
			handleBinaryFrame(bytes)
		}
	}

	/**
	 * 传输就绪后启动握手（发 hello）。
	 * @returns {Promise<void>}
	 */
	async function startHandshake() {
		if (helloSent || closed) return
		handshakeTimer = setTimeout(() => { void close('handshake-timeout') }, handshakeTimeoutMs)
		helloSent = true
		localHello = buildHello(options.localIdentity ?? {})
		await sendRawControl(localHello)
		await maybeSendAuth()
	}

	/**
	 * 发送业务 envelope。
	 * @param {{ scope: string, action: string, payload: unknown }} envelope 信封
	 * @returns {Promise<boolean>} 是否发送成功
	 */
	async function send(envelope) {
		await readyPromise
		if (closed) return false
		const message = {
			scope: String(envelope?.scope || ''),
			action: String(envelope?.action || ''),
			payload: envelope?.payload ?? null,
			msgId: randomMsgIdHex(),
		}
		const bytes = encoder.encode(JSON.stringify(message))
		for (const frame of encodeFrames(message.msgId, bytes)) {
			await Promise.resolve(options.sendFrame(message.action, frame))
			sentFrames++
		}
		lastOutboundAt = Date.now()
		return true
	}

	/**
	 * 关闭 pipe 与底层传输。
	 * @param {string} [reason='closed'] 关闭原因
	 * @returns {Promise<void>}
	 */
	async function close(reason = 'closed') {
		if (closed) return
		closed = true
		closeReason = reason
		clearTimeout(handshakeTimer)
		if (heartbeatTimer) clearInterval(heartbeatTimer)
		if (idleTimer) clearInterval(idleTimer)
		try { await Promise.resolve(options.closeTransport?.()) } catch { /* ignore */ }
		if (!ready) rejectReady(new Error(`p2p: link closed before ready (${reason})`))
		emitListeners(downListeners, reason)
	}

	return {
		ready: readyPromise,
		/** @returns {string | null} 对端 nodeHash（握手后） */
		get nodeHash() { return remoteNodeHash },
		/** @returns {boolean} 是否发起方 */
		get initiator() { return !!options.initiator },
		/** @returns {string} 提供者 id */
		get providerId() { return providerId },
		/** @returns {number} 提供者 level */
		get level() { return level },
		send,
		/**
		 * @param {(envelope: object, remoteNodeHash: string) => void} callback 回调
		 * @returns {() => void} 取消订阅
		 */
		onEnvelope(callback) {
			envelopeListeners.add(callback)
			return () => envelopeListeners.delete(callback)
		},
		/**
		 * @param {(reason: string) => void} callback 回调
		 * @returns {() => void} 取消订阅
		 */
		onDown(callback) {
			downListeners.add(callback)
			return () => downListeners.delete(callback)
		},
		close,
		handleInbound,
		startHandshake,
		maybeSendAuth,
		/**
		 * @returns {object} 运行时统计
		 */
		stats() {
			return {
				ready,
				providerId,
				level,
				nodeHash: remoteNodeHash,
				targetNodeHash: targetNodeHash || null,
				initiator: !!options.initiator,
				lastInboundAt,
				lastOutboundAt,
				sentFrames,
				recvFrames,
				closeReason,
				...options.extraStats?.() ?? {},
			}
		},
	}
}
