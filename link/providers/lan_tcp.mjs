import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import net from 'node:net'

import { normalizeHex64 } from '../../core/hexIds.mjs'
import { getLanPeerHint, listLanPeerHints } from '../../discovery/lan_peer_hints.mjs'
import { asLinkHandle } from '../pipe.mjs'

import { LINK_LEVEL_LAN_TCP } from './levels.mjs'
import { buildLinkOpen, createLinkIdBoundPipe, parseLinkOpen } from './link_id_pipe.mjs'

const MAX_FRAME_BYTES = 1 << 20
/** LAN TCP 单 endpoint 连接超时。 */
const LAN_TCP_CONNECT_TIMEOUT_MS = 3_000

/**
 * @param {string} host 目标 host
 * @param {number} port 目标 port
 * @param {number} [timeoutMs=LAN_TCP_CONNECT_TIMEOUT_MS] 超时
 * @returns {Promise<import('node:net').Socket>} 已连接 socket
 */
function connectTcp(host, port, timeoutMs = LAN_TCP_CONNECT_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const conn = net.createConnection({ host, port })
		const timer = setTimeout(() => {
			conn.destroy()
			reject(new Error(`p2p: lan_tcp connect timeout ${host}:${port}`))
		}, timeoutMs)
		/**
		 * @param {Error} error 连接错误
		 * @returns {void}
		 */
		const onError = error => {
			clearTimeout(timer)
			conn.off('connect', onConnect)
			reject(error)
		}
		/**
		 * @returns {void}
		 */
		function onConnect() {
			clearTimeout(timer)
			conn.off('error', onError)
			resolve(conn)
		}
		conn.once('error', onError)
		conn.once('connect', onConnect)
	})
}

/**
 * 在 socket 上挂 length-prefix 编解码（u32be + payload）。
 * @param {import('node:net').Socket} socket TCP socket
 * @param {(payload: Buffer) => void} onPayload 完整帧回调
 * @returns {{ write: (payload: Buffer | Uint8Array | string) => void, destroy: () => void }} 编解码句柄
 */
function attachLengthPrefix(socket, onPayload) {
	/** @type {Buffer[]} */
	const chunks = []
	let buffered = 0
	/**
	 * @param {number} n 需要的字节数
	 * @returns {Buffer | null} 凑齐则返回，否则 null
	 */
	function take(n) {
		if (buffered < n) return null
		const out = Buffer.allocUnsafe(n)
		let offset = 0
		while (offset < n) {
			const head = chunks[0]
			const copy = Math.min(head.length, n - offset)
			head.copy(out, offset, 0, copy)
			offset += copy
			buffered -= copy
			if (copy === head.length) chunks.shift()
			else chunks[0] = head.subarray(copy)
		}
		return out
	}
	/**
	 * @param {Buffer} chunk 入站数据
	 * @returns {void}
	 */
	function onData(chunk) {
		chunks.push(chunk)
		buffered += chunk.length
		while (buffered >= 4) {
			const header = take(4)
			const len = header.readUInt32BE(0)
			if (len > MAX_FRAME_BYTES) {
				socket.destroy(new Error('p2p: lan_tcp frame too large'))
				return
			}
			if (buffered < len) {
				chunks.unshift(header)
				buffered += 4
				return
			}
			onPayload(take(len))
		}
	}
	socket.on('data', onData)
	return {
		/**
		 * @param {Buffer | Uint8Array | string} payload 出站载荷
		 * @returns {void}
		 */
		write(payload) {
			const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
			const header = Buffer.allocUnsafe(4)
			header.writeUInt32BE(body.length)
			socket.write(Buffer.concat([header, body]))
		},
		/**
		 * @returns {void}
		 */
		destroy() {
			socket.off('data', onData)
		},
	}
}

/**
 * 在已挂 codec 的 socket 上创建 pipe。
 * @param {object} options 配置
 * @returns {ReturnType<typeof createLinkIdBoundPipe>} pipe 句柄
 */
function createTcpPipe(options) {
	const { socket, codec } = options
	const pipe = createLinkIdBoundPipe({
		providerId: 'lan_tcp',
		level: LINK_LEVEL_LAN_TCP,
		initiator: !!options.initiator,
		linkId: options.linkId,
		nodeHash: options.nodeHash,
		localIdentity: options.localIdentity,
		/**
		 * @param {string} text control JSON
		 * @returns {void}
		 */
		sendControlText(text) {
			codec.write(text)
		},
		/**
		 * @param {string} _action action
		 * @param {Uint8Array} frame 帧
		 * @returns {void}
		 */
		sendFrame(_action, frame) {
			codec.write(frame)
		},
		/**
		 * @returns {void}
		 */
		closeTransport() {
			codec.destroy()
			socket.destroy()
		},
		/**
		 * @returns {object} 附加 stats
		 */
		extraStats() {
			return { host: options.host || null, port: options.port || null }
		},
	})
	socket.on('close', () => { void pipe.close('socket-close') })
	socket.on('error', () => { void pipe.close('socket-error') })
	return pipe
}

/**
 * 在已连接 socket 上建立 pipe（入站帧经 pending 缓冲，避免 link-open/hello 竞态丢包）。
 * @param {object} options 配置
 * @returns {Promise<import('./index.mjs').LinkHandle>} 已启动握手的 link
 */
async function openTcpPipe(options) {
	const { socket } = options
	/** @type {ReturnType<typeof createLinkIdBoundPipe> | null} */
	let pipe = null
	/** @type {Buffer[]} */
	const pending = []
	const codec = attachLengthPrefix(socket, payload => {
		if (!pipe) {
			pending.push(payload)
			return
		}
		pipe.handleInbound(payload)
	})

	pipe = createTcpPipe({ ...options, codec, socket })
	for (const payload of pending.splice(0))
		pipe.handleInbound(payload)

	if (options.initiator)
		codec.write(buildLinkOpen(normalizeHex64(options.linkId), options.localIdentity?.nodeHash))

	await pipe.startHandshake()
	return asLinkHandle(pipe)
}

/**
 * 拨号到已有 LAN hint。
 * @param {object} options dial 选项
 * @returns {Promise<import('./index.mjs').LinkHandle>} 已就绪的 link
 */
async function dialLanTcp(options) {
	const remoteNodeHash = normalizeHex64(options.nodeHash)
	const hints = listLanPeerHints(remoteNodeHash)
	if (!hints.length) throw new Error('p2p: lan_tcp no peer hint')

	let lastError = null
	for (const hint of hints) {
		/** @type {import('node:net').Socket | null} */
		let socket = null
		try {
			socket = await connectTcp(hint.host, hint.port)
			const link = await openTcpPipe({
				initiator: true,
				linkId: randomBytes(32).toString('hex'),
				nodeHash: remoteNodeHash,
				localIdentity: options.localIdentity,
				socket,
				host: hint.host,
				port: hint.port,
			})
			await link.ready
			return link
		}
		catch (error) {
			lastError = error
			try { socket?.destroy() } catch { /* ignore */ }
		}
	}
	throw lastError || new Error('p2p: lan_tcp dial failed')
}

/**
 * 创建 lan_tcp LinkProvider。
 * 每个实例独立 listen socket；注册 id 唯一，避免同进程多 registry 互相覆盖。
 * 链路上的 `providerId` 仍为 `lan_tcp`（见 createTcpPipe）。
 * @returns {import('./index.mjs').LinkProvider & { ensureListening?: Function, localEndpoint?: Function }} LAN TCP provider
 */
export function createLanTcpLinkProvider() {
	const instanceId = `lan_tcp:${randomBytes(4).toString('hex')}`
	/** @type {((link: import('./index.mjs').LinkHandle) => void) | null} */
	let onInbound = null
	/** @type {object | null} */
	let localIdentity = null
	/** @type {import('node:net').Server | null} */
	let server = null
	let listenPort = 0

	/**
	 * @param {import('node:net').Socket} socket 入站连接
	 * @returns {void}
	 */
	function acceptConnection(socket) {
		if (!onInbound || !localIdentity) {
			socket.destroy()
			return
		}
		/** @type {ReturnType<typeof createLinkIdBoundPipe> | null} */
		let pipe = null
		const codec = attachLengthPrefix(socket, payload => {
			if (pipe) {
				pipe.handleInbound(payload)
				return
			}
			const opened = parseLinkOpen(payload)
			if (!opened) {
				socket.destroy()
				return
			}
			try {
				pipe = createTcpPipe({
					initiator: false,
					linkId: opened.linkId,
					nodeHash: opened.from,
					localIdentity,
					socket,
					codec,
					port: listenPort,
				})
			}
			catch {
				socket.destroy()
				return
			}
			onInbound?.(asLinkHandle(pipe))
			void pipe.startHandshake().catch(() => {
				socket.destroy()
			})
		})
		socket.on('error', () => { /* ignore */ })
	}

	return {
		id: instanceId,
		level: LINK_LEVEL_LAN_TCP,
		caps: { needsOfferAnswer: false, needsDiscoverySignal: false, probe: 'sync' },
		/**
		 * @returns {boolean} 始终可用
		 */
		isAvailable() {
			return true
		},
		/**
		 * @param {{ nodeHash: string }} remote 远端
		 * @returns {boolean} 是否有 LAN peer hint
		 */
		canReach(remote) {
			return !!getLanPeerHint(remote.nodeHash)
		},
		/**
		 * @returns {{ port: number } | null} 本机 listen 端点
		 */
		localEndpoint() {
			return listenPort > 0 ? { port: listenPort } : null
		},
		/**
		 * @param {object} options dial 选项
		 * @returns {Promise<import('./index.mjs').LinkHandle>} 已就绪的 link
		 */
		async dial(options) {
			return dialLanTcp(options)
		},
		/**
		 * @param {{ onInbound: (link: import('./index.mjs').LinkHandle) => void, localIdentity: object }} handlers 回调
		 * @returns {Promise<() => void>} 停止 listening
		 */
		async ensureListening(handlers) {
			onInbound = handlers.onInbound
			localIdentity = handlers.localIdentity
			if (!server) {
				server = net.createServer(acceptConnection)
				await new Promise((resolve, reject) => {
					server.once('error', reject)
					server.listen(0, '0.0.0.0', () => {
						server.off('error', reject)
						const addr = server.address()
						listenPort = addr?.port || 0
						resolve()
					})
				})
			}
			return () => {
				onInbound = null
				if (server) {
					server.close()
					server = null
					listenPort = 0
				}
			}
		},
	}
}
