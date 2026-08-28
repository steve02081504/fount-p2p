import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

import { isHex64, isSignatureHex128 } from '../core/hexIds.mjs'
import { normalizeTcpPort } from '../core/tcp_port.mjs'
import { keyPairFromSeed, pubKeyHash, sign, verify } from '../crypto/crypto.mjs'
import { normalizeLanHosts } from '../discovery/lan_interfaces.mjs'
import { MAX_ADVERT_LISTEN_RELAYS, MAX_ADVERT_RELAY_POOL, MAX_RTT_MS } from '../discovery/nostr/constants.mjs'
import { normalizeNostrRelayUrl } from '../discovery/nostr/relays.mjs'
import { ensureNodeSeed, getNodeHash } from '../node/identity.mjs'
import { nodeDebug } from '../node/log.mjs'

import { normalizeDtlsFingerprint } from './sdp_fingerprint.mjs'

/**
 * Link 握手签名域标识符。
 */
export const LINK_HANDSHAKE_DOMAIN = 'fount-link'

/**
 * 规范化链路绑定材料：DTLS fingerprint 或 64-hex linkId。
 * @param {unknown} value 原始 binding
 * @returns {string | null} 规范化 binding，无效时 null
 */
export function normalizeLinkBinding(value) {
	const dtls = normalizeDtlsFingerprint(value)
	if (dtls) return dtls
	return isHex64(value)
}

/**
 * 构造 link auth 待签名字节串。
 * @param {string} peerNonce 对端 hello 中的 nonce（64 位 hex）
 * @param {string} localBinding 本地绑定材料（DTLS fingerprint 或 linkId）
 * @param {string} localNodeHash 本地节点 nodeHash（64 位 hex）
 * @returns {Uint8Array} 待签名消息字节
 */
export function buildAuthMessage(peerNonce, localBinding, localNodeHash) {
	const nonce = peerNonce
	const binding = normalizeLinkBinding(localBinding)
	const nodeHash = localNodeHash
	if (!/^[\da-f]{64}$/u.test(nonce))
		throw new Error('p2p: auth nonce must be 64 hex characters')
	if (!binding)
		throw new Error('p2p: link binding missing or invalid')
	if (!isHex64(nodeHash))
		throw new Error('p2p: nodeHash must be 64 hex characters')
	return Buffer.from(`${LINK_HANDSHAKE_DOMAIN}\0${nonce}\0${binding}\0${nodeHash}`, 'utf8')
}

/**
 * 构造 link hello 握手包。
 * @param {{ nodeHash?: string, nodePubKey?: string, nonce?: string }} [options] 可选身份字段，省略则从本地节点种子推导
 * @returns {{ nodeHash: string, nodePubKey: string, nonce: string }} hello 对象
 */
export function buildHello(options = {}) {
	let publicKey = null
	if (!options.nodeHash || !options.nodePubKey) {
		const derived = keyPairFromSeed(Buffer.from(ensureNodeSeed(), 'hex'))
		publicKey = derived.publicKey
	}
	const nodeHash = isHex64(options.nodeHash || getNodeHash())
	const nodePubKey = isHex64(options.nodePubKey || Buffer.from(publicKey).toString('hex'))
	const nonce = isHex64(options.nonce || randomBytes(32).toString('hex'))
	if (!nodeHash || !nodePubKey || !nonce)
		throw new Error('p2p: invalid hello fields')
	if (pubKeyHash(Buffer.from(nodePubKey, 'hex')) !== nodeHash)
		throw new Error('p2p: hello nodePubKey does not match nodeHash')
	return { nodeHash, nodePubKey, nonce }
}

/**
 * 对 link auth 消息签名。
 * @param {string} peerNonce 对端 hello 中的 nonce
 * @param {string} localBinding 本地绑定材料（DTLS fingerprint 或 linkId）
 * @param {{ secretKey?: Uint8Array, nodeHash?: string }} [options] 签名密钥与 nodeHash 覆盖
 * @returns {Promise<{ sig: string }>} hex 签名
 */
export async function buildAuth(peerNonce, localBinding, options = {}) {
	const seed = options.secretKey
		? Buffer.from(options.secretKey)
		: Buffer.from(ensureNodeSeed(), 'hex')
	const { publicKey, secretKey } = keyPairFromSeed(seed)
	const nodeHash = options.nodeHash || pubKeyHash(publicKey)
	if (nodeHash !== pubKeyHash(publicKey))
		throw new Error('p2p: auth nodeHash does not match secretKey')
	const message = buildAuthMessage(peerNonce, localBinding, nodeHash)
	const signature = await sign(message, secretKey)
	return { sig: Buffer.from(signature).toString('hex') }
}

/**
 * 解析并校验 hello 对象，无效时返回 null。
 * @param {unknown} hello 原始 hello 载荷
 * @returns {{ nodeHash: string, nodePubKey: string, nonce: string } | null} 规范化 hello 或 null
 */
export function parseHello(hello) {
	const nodeHash = isHex64(hello?.nodeHash)
	const nodePubKey = isHex64(hello?.nodePubKey)
	const nonce = isHex64(hello?.nonce)
	if (!nodeHash || !nodePubKey || !nonce) return null
	try {
		if (pubKeyHash(Buffer.from(nodePubKey, 'hex')) !== nodeHash) return null
	}
	catch {
		return null
	}
	return { nodeHash, nodePubKey, nonce }
}

/**
 * 验证对端 auth 签名，成功返回对端 nodeHash。
 * @param {unknown} hello 对端 hello
 * @param {unknown} auth 对端 auth（含 sig）
 * @param {string} expectedNonce 本地 hello 发出的 nonce
 * @param {string} remoteBinding 对端绑定材料（DTLS fingerprint 或 linkId）
 * @returns {Promise<string | null>} 验证通过的 nodeHash，失败返回 null
 */
export async function verifyAuth(hello, auth, expectedNonce, remoteBinding) {
	const parsedHello = parseHello(hello)
	if (!parsedHello) return null
	const signatureHex = isSignatureHex128(auth?.sig)
	const binding = normalizeLinkBinding(remoteBinding)
	if (!signatureHex || !binding) return null
	const normalizedNonce = isHex64(expectedNonce)
	if (!normalizedNonce) return null
	const message = buildAuthMessage(normalizedNonce, binding, parsedHello.nodeHash)
	const ok = await verify(
		Buffer.from(signatureHex, 'hex'),
		message,
		Buffer.from(parsedHello.nodePubKey, 'hex'),
	)
	return ok ? parsedHello.nodeHash : null
}

/**
 * 构造 discovery advert 待签名字节串。
 * @param {string} rendezvousKey discovery 内部汇合键
 * @param {number} ts 时间戳（毫秒）
 * @param {string} nodeHash 节点 nodeHash
 * @param {number | null} [tcpPort=null] 可选 LAN TCP 监听端口（签入消息）
 * @param {unknown} [lanHosts=null] 可选 LAN IPv4 列表（签入消息）
 * @param {string | null} [relayBlobHex=null] 可选规范化 relay 字段 hex 段（签入消息）
 * @returns {Uint8Array} 待签名消息字节
 */
export function buildAdvertMessage(rendezvousKey, ts, nodeHash, tcpPort = null, lanHosts = null, relayBlobHex = null) {
	const base = `fount-advert\0${rendezvousKey}\0${ts}\0${nodeHash}`
	const port = normalizeTcpPort(tcpPort)
	let message = port ? `${base}\0${port}` : base
	const hosts = normalizeLanHosts(lanHosts)
	if (hosts.length) message += `\0${hosts.join(',')}`
	if (relayBlobHex) message += `\0relays:${relayBlobHex}`
	return Buffer.from(message, 'utf8')
}

/**
 * 规范化并裁剪入站（不可信）advert 携带的 relay 字段：无效项丢弃并记审计日志，不抛错。
 * - pool：url 经 normalize 有效且 rttMs∈[0,MAX_RTT_MS]，取整、去重、裁剪前 MAX_ADVERT_RELAY_POOL。
 * - listen：url normalize 有效、去重、裁剪前 MAX_ADVERT_LISTEN_RELAYS。
 * - 每个丢弃项记审计日志（含原始值），不静默。
 * @param {unknown} rawPool 原始 pool（[{url, rttMs}]）
 * @param {unknown} rawListen 原始 listen（[url]）
 * @returns {{ pool: Array<{ url: string, rtt: number }>, listen: string[] }} 规范化结果
 */
export function sanitizeAdvertRelayFields(rawPool, rawListen) {
	/** @type {Array<{ url: string, rtt: number }>} */
	const pool = []
	/** @type {Set<string>} */
	const seenPool = new Set()
	if (Array.isArray(rawPool)) for (const item of rawPool) {
		const url = normalizeNostrRelayUrl(item?.url)
		if (!url) {
			nodeDebug('invalidRelayUrl', { url: String(item?.url), reason: 'advert-pool-invalid-url' })
			continue
		}
		const rtt = Number(item?.rttMs ?? item?.rtt)
		if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_RTT_MS) {
			nodeDebug('invalidRelayUrl', { url, reason: 'advert-pool-invalid-rtt', rttMs: item?.rttMs ?? item?.rtt })
			continue
		}
		if (seenPool.has(url)) continue
		seenPool.add(url)
		pool.push({ url, rtt: Math.round(rtt) })
		if (pool.length >= MAX_ADVERT_RELAY_POOL) break
	}

	/** @type {string[]} */
	const listen = []
	/** @type {Set<string>} */
	const seenListen = new Set()
	if (Array.isArray(rawListen)) for (const raw of rawListen) {
		const url = normalizeNostrRelayUrl(raw)
		if (!url) {
			nodeDebug('invalidRelayUrl', { url: String(raw), reason: 'advert-listen-invalid-url' })
			continue
		}
		if (seenListen.has(url)) continue
		seenListen.add(url)
		listen.push(url)
		if (listen.length >= MAX_ADVERT_LISTEN_RELAYS) break
	}

	return { pool, listen }
}

/**
 * 构建规范化 relay 字段的 canonical blob（pool/listen 各按 url 排序 → `{p,l}` JSON → UTF-8 → hex）。
 * @param {Array<{ url: string, rtt: number }>} pool 规范化 pool
 * @param {string[]} listen 规范化 listen
 * @returns {string} hex 编码 blob
 */
export function canonicalAdvertRelayBlob(pool, listen) {
	return Buffer.from(JSON.stringify({
		p: [...pool].sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
		l: [...listen].sort(),
	}), 'utf8').toString('hex')
}

/**
 * 严格规范化本机（出站）提供的 relay 字段：无效数据立即抛错，不静默丢弃。
 * 本地调用方应提供已规范化字段；入站校验仍走 lenient 的 sanitizeAdvertRelayFields。
 * @param {unknown} rawPool 原始 pool（[{url, rttMs}]）
 * @param {unknown} rawListen 原始 listen（[url]）
 * @returns {{ pool: Array<{ url: string, rtt: number }>, listen: string[] }} 规范化结果
 */
function normalizeLocalRelayFields(rawPool, rawListen) {
	/** @type {Array<{ url: string, rtt: number }>} */
	const pool = []
	/** @type {Set<string>} */
	const seenPool = new Set()
	if (Array.isArray(rawPool)) for (const item of rawPool) {
		const url = normalizeNostrRelayUrl(item?.url)
		if (!url) throw new Error('p2p: advert pool invalid url')
		const rtt = Number(item?.rttMs ?? item?.rtt)
		if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_RTT_MS)
			throw new Error('p2p: advert pool invalid rtt')
		if (seenPool.has(url)) continue
		seenPool.add(url)
		pool.push({ url, rtt: Math.round(rtt) })
		if (pool.length >= MAX_ADVERT_RELAY_POOL) break
	}

	/** @type {string[]} */
	const listen = []
	/** @type {Set<string>} */
	const seenListen = new Set()
	if (Array.isArray(rawListen)) for (const raw of rawListen) {
		const url = normalizeNostrRelayUrl(raw)
		if (!url) throw new Error('p2p: advert listen invalid url')
		if (seenListen.has(url)) continue
		seenListen.add(url)
		listen.push(url)
		if (listen.length >= MAX_ADVERT_LISTEN_RELAYS) break
	}

	return { pool, listen }
}

/**
 * 构造带签名的 discovery advert（tcpPort / lanHosts / relay 字段一并签入消息）。
 * @param {string} rendezvousKey discovery 内部汇合键
 * @param {number} [ts=Date.now()] 时间戳（毫秒）
 * @param {{ secretKey?: Uint8Array, nodeHash?: string, nodePubKey?: string, tcpPort?: number, lanHosts?: unknown, nostrRelayPool?: unknown, listenNostrRelays?: unknown } | null} [options] 签名身份；可选 LAN 监听端口、本机 IPv4 列表与 relay 字段
 * @returns {Promise<{ nodeHash: string, nodePubKey: string, ts: number, sig: string, tcpPort?: number, lanHosts?: string[], nostrRelayPool?: Array<{ url: string, rtt: number }>, listenNostrRelays?: string[] }>} 签名 advert
 */
export async function buildSignedAdvert(rendezvousKey, ts = Date.now(), options = null) {
	const seed = options?.secretKey
		? Buffer.from(options.secretKey)
		: Buffer.from(ensureNodeSeed(), 'hex')
	const { publicKey, secretKey } = keyPairFromSeed(seed)
	const nodeHash = options?.nodeHash || pubKeyHash(publicKey)
	const nodePubKey = options?.nodePubKey || Buffer.from(publicKey).toString('hex')
	if (pubKeyHash(Buffer.from(nodePubKey, 'hex')) !== nodeHash)
		throw new Error('p2p: advert nodePubKey does not match nodeHash')
	const tcpPort = normalizeTcpPort(options?.tcpPort)
	if (options?.tcpPort && !tcpPort)
		throw new Error('p2p: advert tcpPort invalid')
	const lanHosts = normalizeLanHosts(options?.lanHosts)
	// 出站字段要求已规范化，无效数据直接抛错（入站路径才用 lenient sanitize）。
	const normalized = normalizeLocalRelayFields(options?.nostrRelayPool, options?.listenNostrRelays)
	const message = buildAdvertMessage(rendezvousKey, ts, nodeHash, tcpPort, lanHosts,
		canonicalAdvertRelayBlob(normalized.pool, normalized.listen))
	const sig = await sign(message, secretKey)
	const advert = {
		nodeHash,
		nodePubKey,
		ts,
		sig: Buffer.from(sig).toString('hex'),
	}
	if (tcpPort) advert.tcpPort = tcpPort
	if (lanHosts.length) advert.lanHosts = lanHosts
	if (normalized.pool.length) advert.nostrRelayPool = normalized.pool
	if (normalized.listen.length) advert.listenNostrRelays = normalized.listen
	return advert
}

/**
 * 验证 discovery advert 签名与时间戳，成功返回发布者 nodeHash 与规范化后的 relay 字段。
 * @param {string} rendezvousKey 期望的汇合键
 * @param {unknown} advert 原始 advert 载荷
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [maxSkewMs=10 * 60_000] 允许的最大时钟偏差（毫秒）
 * @returns {Promise<{ nodeHash: string, relayPool: Array<{ url: string, rtt: number }>, listenRelays: string[] } | null>} 验证通过返回 nodeHash 与规范化 relay 字段，失败返回 null
 */
export async function verifySignedAdvert(rendezvousKey, advert, now = Date.now(), maxSkewMs = 10 * 60_000) {
	const parsedHello = parseHello({ nodeHash: advert?.nodeHash, nodePubKey: advert?.nodePubKey, nonce: '0'.repeat(64) })
	if (!parsedHello) return null
	const ts = Number(advert?.ts)
	const sig = isSignatureHex128(advert?.sig)
	if (!Number.isFinite(ts) || Math.abs(now - ts) > maxSkewMs || !sig) return null
	const hasTcpPortField = !!advert?.tcpPort
	const tcpPort = normalizeTcpPort(advert?.tcpPort)
	if (hasTcpPortField && !tcpPort) return null
	const lanHosts = normalizeLanHosts(advert?.lanHosts)
	// 入站用 lenient sanitize 防御畸形输入，重建消息比对签名。
	const sanitized = sanitizeAdvertRelayFields(advert?.nostrRelayPool, advert?.listenNostrRelays)
	const ok = await verify(Buffer.from(sig, 'hex'),
		buildAdvertMessage(rendezvousKey, ts, parsedHello.nodeHash, tcpPort, lanHosts,
			canonicalAdvertRelayBlob(sanitized.pool, sanitized.listen)),
		Buffer.from(parsedHello.nodePubKey, 'hex'))
	if (!ok) return null
	return { nodeHash: parsedHello.nodeHash, relayPool: sanitized.pool, listenRelays: sanitized.listen }
}
