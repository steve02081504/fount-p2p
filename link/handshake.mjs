import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'
import { normalizeTcpPort } from '../core/tcp_port.mjs'
import { keyPairFromSeed, pubKeyHash, sign, verify } from '../crypto/crypto.mjs'
import { normalizeLanHosts } from '../discovery/lan_interfaces.mjs'
import { ensureNodeSeed, getNodeHash } from '../node/identity.mjs'

import { normalizeDtlsFingerprint } from './sdp_fingerprint.mjs'

/** advert / peer-hint 端口规范化（re-export，调用方可直接从 core/tcp_port 导入） */
export const normalizeAdvertTcpPort = normalizeTcpPort

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
	const hex = normalizeHex64(value)
	return isHex64(hex) ? hex : null
}

/**
 * 构造 link auth 待签名字节串。
 * @param {string} peerNonce 对端 hello 中的 nonce（64 位 hex）
 * @param {string} localBinding 本地绑定材料（DTLS fingerprint 或 linkId）
 * @param {string} localNodeHash 本地节点 nodeHash（64 位 hex）
 * @returns {Uint8Array} 待签名消息字节
 */
export function buildAuthMessage(peerNonce, localBinding, localNodeHash) {
	const nonce = normalizeHex64(peerNonce)
	const binding = normalizeLinkBinding(localBinding)
	const nodeHash = normalizeHex64(localNodeHash)
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
	const nodeHash = normalizeHex64(options.nodeHash || getNodeHash())
	const nodePubKey = normalizeHex64(options.nodePubKey || Buffer.from(publicKey).toString('hex'))
	const nonce = normalizeHex64(options.nonce || randomBytes(32).toString('hex'))
	if (!isHex64(nodeHash) || !isHex64(nodePubKey) || !isHex64(nonce))
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
	const nodeHash = normalizeHex64(options.nodeHash || pubKeyHash(publicKey))
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
	const nodeHash = normalizeHex64(hello?.nodeHash)
	const nodePubKey = normalizeHex64(hello?.nodePubKey)
	const nonce = normalizeHex64(hello?.nonce)
	if (!isHex64(nodeHash) || !isHex64(nodePubKey) || !isHex64(nonce)) return null
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
	const signatureHex = String(auth?.sig ?? '').trim().toLowerCase()
	const binding = normalizeLinkBinding(remoteBinding)
	if (!/^[\da-f]{128}$/u.test(signatureHex) || !binding) return null
	const normalizedNonce = normalizeHex64(expectedNonce)
	if (!isHex64(normalizedNonce)) return null
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
 * @returns {Uint8Array} 待签名消息字节
 */
export function buildAdvertMessage(rendezvousKey, ts, nodeHash, tcpPort = null, lanHosts = null) {
	const base = `fount-advert\0${String(rendezvousKey)}\0${String(ts)}\0${normalizeHex64(nodeHash)}`
	const port = normalizeTcpPort(tcpPort)
	let message = port ? `${base}\0${port}` : base
	const hosts = normalizeLanHosts(lanHosts)
	if (hosts.length) message += `\0${hosts.join(',')}`
	return Buffer.from(message, 'utf8')
}

/**
 * 构造带签名的 discovery advert（tcpPort / lanHosts 一并签入消息）。
 * @param {string} rendezvousKey discovery 内部汇合键
 * @param {number} [ts=Date.now()] 时间戳（毫秒）
 * @param {{ secretKey?: Uint8Array, nodeHash?: string, nodePubKey?: string, tcpPort?: number, lanHosts?: unknown } | null} [options] 签名身份；可选 LAN 监听端口与本机 IPv4 列表
 * @returns {Promise<{ nodeHash: string, nodePubKey: string, ts: number, sig: string, tcpPort?: number, lanHosts?: string[] }>} 签名 advert
 */
export async function buildSignedAdvert(rendezvousKey, ts = Date.now(), options = null) {
	const seed = options?.secretKey
		? Buffer.from(options.secretKey)
		: Buffer.from(ensureNodeSeed(), 'hex')
	const { publicKey, secretKey } = keyPairFromSeed(seed)
	const nodeHash = normalizeHex64(options?.nodeHash || pubKeyHash(publicKey))
	const nodePubKey = normalizeHex64(options?.nodePubKey || Buffer.from(publicKey).toString('hex'))
	if (pubKeyHash(Buffer.from(nodePubKey, 'hex')) !== nodeHash)
		throw new Error('p2p: advert nodePubKey does not match nodeHash')
	const tcpPort = normalizeTcpPort(options?.tcpPort)
	if (options?.tcpPort && !tcpPort)
		throw new Error('p2p: advert tcpPort invalid')
	const lanHosts = normalizeLanHosts(options?.lanHosts)
	const message = buildAdvertMessage(rendezvousKey, ts, nodeHash, tcpPort, lanHosts)
	const sig = await sign(message, secretKey)
	const advert = {
		nodeHash,
		nodePubKey,
		ts,
		sig: Buffer.from(sig).toString('hex'),
	}
	if (tcpPort) advert.tcpPort = tcpPort
	if (lanHosts.length) advert.lanHosts = lanHosts
	return advert
}

/**
 * 验证 discovery advert 签名与时间戳，成功返回发布者 nodeHash。
 * @param {string} rendezvousKey 期望的汇合键
 * @param {unknown} advert 原始 advert 载荷
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [maxSkewMs=10 * 60_000] 允许的最大时钟偏差（毫秒）
 * @returns {Promise<string | null>} 验证通过的 nodeHash，失败返回 null
 */
export async function verifySignedAdvert(rendezvousKey, advert, now = Date.now(), maxSkewMs = 10 * 60_000) {
	const parsedHello = parseHello({ nodeHash: advert?.nodeHash, nodePubKey: advert?.nodePubKey, nonce: '0'.repeat(64) })
	if (!parsedHello) return null
	const ts = Number(advert?.ts)
	const sig = String(advert?.sig ?? '').trim().toLowerCase()
	if (!Number.isFinite(ts) || Math.abs(now - ts) > maxSkewMs || !/^[\da-f]{128}$/u.test(sig)) return null
	const hasTcpPortField = !!advert?.tcpPort
	const tcpPort = normalizeTcpPort(advert?.tcpPort)
	if (hasTcpPortField && !tcpPort) return null
	const lanHosts = normalizeLanHosts(advert?.lanHosts)
	const message = buildAdvertMessage(rendezvousKey, ts, parsedHello.nodeHash, tcpPort, lanHosts)
	const ok = await verify(Buffer.from(sig, 'hex'), message, Buffer.from(parsedHello.nodePubKey, 'hex'))
	return ok ? parsedHello.nodeHash : null
}
