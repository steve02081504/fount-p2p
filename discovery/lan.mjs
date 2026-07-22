import { Buffer } from 'node:buffer'
import dgram from 'node:dgram'

import { base64ToBytes, bytesToBase64 } from '../core/bytes_codec.mjs'
import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'
import { nodeDebug, shortHash } from '../node/log.mjs'

import { ingestNetworkAdvert } from './adverts.mjs'
import { getLanPeerHint, noteLanPeerHint } from './lan_peer_hints.mjs'

const DEFAULT_PORT = 53531
const DEFAULT_GROUP = '239.255.42.99'
const BEACON_INTERVAL_MS = 30_000

/** @type {Map<string, number>} nodeHash → lastSeenAt */
const visibleByHash = new Map()

/**
 * 记入 LAN 可见池。
 * @param {string} nodeHash 节点 hash
 * @param {number} [now=Date.now()] 当前时间
 * @returns {void}
 */
export function noteLanVisibleNode(nodeHash, now = Date.now()) {
	const hash = normalizeHex64(nodeHash)
	if (!isHex64(hash)) return
	visibleByHash.set(hash, now)
}

/**
 * 列出未过期的 LAN 可见 nodeHash。
 * @param {number} [now=Date.now()] 当前时间
 * @param {number} [ttlMs=BEACON_INTERVAL_MS * 3] TTL
 * @returns {string[]} 可见 nodeHash 列表
 */
export function listLanVisibleNodeHashes(now = Date.now(), ttlMs = BEACON_INTERVAL_MS * 3) {
	/** @type {string[]} */
	const out = []
	for (const [hash, seenAt] of visibleByHash)
		if (now - seenAt <= ttlMs) out.push(hash)
		else visibleByHash.delete(hash)

	return out
}

/** @returns {void} 测试用 */
export function clearLanVisibleNodes() {
	visibleByHash.clear()
}

/**
 * Untrusted ingress：验签 network advert 后写入可见池 / peer hint。
 * @param {Uint8Array} advertBytes 加密 network advert
 * @param {{ address?: string }} [meta] 发送方地址
 * @returns {Promise<{ verifiedNodeHash: string, body: object } | null>} 验签结果
 */
export async function acceptLanPresenceAdvert(advertBytes, meta = {}) {
	if (!advertBytes?.byteLength) return null
	const ingested = await ingestNetworkAdvert(advertBytes, meta)
	if (!ingested) return null
	const firstSeen = !visibleByHash.has(ingested.verifiedNodeHash)
	noteLanVisibleNode(ingested.verifiedNodeHash)
	const host = String(meta.address || '').trim()
	const tcpPort = Number(ingested.body?.tcpPort)
	if (host && Number.isFinite(tcpPort) && tcpPort > 0)
		noteLanPeerHint(ingested.verifiedNodeHash, { host, port: tcpPort })
	if (firstSeen)
		nodeDebug('p2p:lan peer visible', {
			peer: shortHash(ingested.verifiedNodeHash),
			host: host || undefined,
			tcpPort: tcpPort > 0 ? tcpPort : undefined,
		})
	return ingested
}

/**
 * LAN UDP presence：段内 beacon，非 topic 订阅模型。
 * @param {{ port?: number, group?: string }} [options] 配置
 * @returns {import('./index.mjs').DiscoveryProvider} LAN 发现提供者
 */
export function createLanDiscoveryProvider(options = {}) {
	const port = Number(options.port) || DEFAULT_PORT
	const group = String(options.group || DEFAULT_GROUP)
	/** @type {import('node:dgram').Socket | null} */
	let socket = null
	let bound = false
	let bindPromise = null
	let refs = 0
	/** @type {ReturnType<typeof setInterval> | null} */
	let beaconTimer = null

	/**
	 * @returns {import('node:dgram').Socket} 复用的组播 UDP socket
	 */
	function getSocket() {
		return socket ||= dgram.createSocket({ type: 'udp4', reuseAddr: true })
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function ensureBound() {
		if (bound) return
		if (!bindPromise)
			bindPromise = (async () => {
				const sock = getSocket()
				await new Promise((resolve, reject) => {
					sock.once('error', reject)
					sock.bind(port, '0.0.0.0', () => {
						sock.off('error', reject)
						sock.addMembership(group)
						sock.setMulticastTTL(1)
						resolve()
					})
				})
				if (refs <= 0) {
					try { sock.close() } catch { /* ignore */ }
					if (socket === sock) socket = null
					bound = false
					return
				}
				sock.on('message', (raw, rinfo) => {
					let packet
					try { packet = JSON.parse(String(raw)) } catch { return }
					if (packet?.type !== 'presence') return
					let advertBytes
					try {
						advertBytes = packet.advertBytes
							? base64ToBytes(packet.advertBytes)
							: null
					}
					catch { return }
					if (!advertBytes?.byteLength) return
					void acceptLanPresenceAdvert(advertBytes, { address: rinfo?.address, provider: 'lan' })
						.catch(() => { })
				})
				bound = true
			})().finally(() => {
				if (!bound) bindPromise = null
			})
		await bindPromise
	}

	/**
	 * @param {object} beacon beacon 载荷
	 * @returns {Promise<void>}
	 */
	async function multicastBeacon(beacon) {
		await ensureBound()
		const sock = getSocket()
		const packet = Buffer.from(JSON.stringify({ type: 'presence', ...beacon }))
		await new Promise((resolve, reject) => {
			sock.send(packet, port, group, error => error ? reject(error) : resolve())
		})
	}

	/**
	 * @returns {() => void} 释放引用；引用归零时关闭 socket
	 */
	function acquire() {
		refs++
		void ensureBound().catch(() => { })
		return () => {
			refs = Math.max(0, refs - 1)
			if (refs > 0 || !socket) return
			if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null }
			try { socket.close() } catch { /* ignore */ }
			socket = null
			bound = false
			bindPromise = null
		}
	}

	return {
		id: 'lan',
		priority: 10,
		caps: { canDiscover: true, canSignal: false, canRelay: false },
		/**
		 * @param {{ limit?: number, roomSecret?: string }} [options] 扫描选项
		 * @returns {Promise<string[]>} 可见 nodeHash；群扫描时 LAN 无群语义，返回空
		 */
		async listVisibleNodeHashes(options = {}) {
			if (options.roomSecret) return []
			const limit = Math.max(1, Number(options.limit) || 64)
			await ensureBound().catch(() => { })
			return listLanVisibleNodeHashes().slice(0, limit)
		},
		/**
		 * 有 LAN peer hint 则可经 lan_tcp 拨号（门面 dialer 完成建链）。
		 * @param {string} nodeHash 目标
		 * @returns {Promise<boolean>} 存在 peer hint 时为 true
		 */
		async connectToNode(nodeHash) {
			const hash = normalizeHex64(nodeHash)
			return isHex64(hash) && !!getLanPeerHint(hash)
		},
		/**
		 * @param {() => Promise<{ nodeHash?: string, tcpPort?: number, advertBytes?: Uint8Array, advertBody?: object } | null>} getBeacon 本机 beacon
		 * @returns {Promise<() => void>} 停止函数
		 */
		async startPresence(getBeacon) {
			const release = acquire()
			/**
			 * @returns {Promise<void>}
			 */
			const send = async () => {
				const body = await getBeacon?.()
				if (!body) return
				const advertBytes = body.advertBytes?.byteLength
					? body.advertBytes
					: null
				if (!advertBytes?.byteLength) return
				await multicastBeacon({
					nodeHash: body.nodeHash,
					tcpPort: body.tcpPort,
					advertBytes: bytesToBase64(advertBytes),
				})
			}
			void send().catch(() => { })
			beaconTimer = setInterval(() => { void send().catch(() => { }) }, BEACON_INTERVAL_MS)
			beaconTimer.unref?.()
			return () => {
				if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null }
				release()
			}
		},
	}
}
