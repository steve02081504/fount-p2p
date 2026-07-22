import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { normalizeHex64 } from '../../core/hexIds.mjs'
import { sha256Hex } from '../../crypto/crypto.mjs'
import { createLruMap } from '../../utils/lru.mjs'

const SIGNAL_DOMAIN = 'fount-signal'
const NODE_RENDEZVOUS_DOMAIN = 'fount-rdv-node:'
const GROUP_RENDEZVOUS_DOMAIN = 'fount-rdv-group:'
const NETWORK_RENDEZVOUS_DOMAIN = 'fount-rdv-network:'

/** rendezvous 键 → AES-256 密钥缓存上限 */
export const SIGNAL_KEY_CACHE_MAX = 512

/**
 * 节点 rendezvous 键（discovery advert / signal）。
 * @param {string} nodeHash 节点 64 hex
 * @returns {string} rendezvous 键
 */
export function nodeRendezvousKey(nodeHash) {
	return sha256Hex(`${NODE_RENDEZVOUS_DOMAIN}${normalizeHex64(nodeHash)}`)
}

/**
 * 群组 rendezvous 键（roomSecret）。
 * @param {string} roomSecret 房间密钥
 * @returns {string} rendezvous 键
 */
export function groupRendezvousKey(roomSecret) {
	return sha256Hex(`${GROUP_RENDEZVOUS_DOMAIN}${roomSecret}`)
}

/**
 * 全网 network-scope rendezvous 键。
 * @returns {string} rendezvous 键
 */
export function networkRendezvousKey() {
	return sha256Hex(NETWORK_RENDEZVOUS_DOMAIN)
}

/** rendezvous 键 → AES-256 密钥 LRU */
const signalKeysByKey = createLruMap(SIGNAL_KEY_CACHE_MAX)

/**
 * @param {string} rendezvousKey rendezvous 键
 * @returns {Buffer} AES-256 密钥
 */
function signalKeyForRendezvous(rendezvousKey) {
	let cached = signalKeysByKey.get(rendezvousKey)
	if (cached) {
		signalKeysByKey.touch(rendezvousKey, cached)
		return cached
	}
	cached = createHash('sha256').update(`${SIGNAL_DOMAIN}:${rendezvousKey}`).digest()
	signalKeysByKey.touch(rendezvousKey, cached)
	return cached
}

/** @returns {number} 密钥缓存条目数（测试用） */
export function signalKeyCacheSize() {
	return signalKeysByKey.size
}

/**
 * AES-GCM 封装 JSON 信令 / advert 包。
 * @param {string} rendezvousKey rendezvous 键
 * @param {unknown} packet 待加密 JSON
 * @returns {Uint8Array} 加密字节
 */
export function encryptSignalPacket(rendezvousKey, packet) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', signalKeyForRendezvous(rendezvousKey), iv)
	const ciphertext = Buffer.concat([
		cipher.update(Buffer.from(JSON.stringify(packet), 'utf8')),
		cipher.final(),
	])
	return Buffer.from(JSON.stringify({
		iv: iv.toString('base64'),
		authTag: cipher.getAuthTag().toString('base64'),
		ciphertext: ciphertext.toString('base64'),
	}))
}

/**
 * Untrusted ingress：AES-GCM 解密信令 / advert；失败返回 null。
 * @param {string} rendezvousKey rendezvous 键
 * @param {Uint8Array} bytes 加密字节
 * @returns {object | null} 解密 JSON 或 null
 */
export function decryptSignalPacket(rendezvousKey, bytes) {
	try {
		const payload = JSON.parse(Buffer.from(bytes).toString('utf8'))
		const decipher = createDecipheriv(
			'aes-256-gcm',
			signalKeyForRendezvous(rendezvousKey),
			Buffer.from(payload.iv, 'base64'),
		)
		decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'))
		const plain = Buffer.concat([
			decipher.update(Buffer.from(payload.ciphertext, 'base64')),
			decipher.final(),
		])
		return JSON.parse(plain.toString('utf8'))
	}
	catch {
		return null
	}
}
