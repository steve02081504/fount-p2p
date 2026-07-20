import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { normalizeHex64 } from '../core/hexIds.mjs'
import { sha256Hex } from '../crypto/crypto.mjs'

const SIGNAL_DOMAIN = 'fount-signal'
const NODE_TOPIC_DOMAIN = 'fount-rdv-node:'
const GROUP_TOPIC_DOMAIN = 'fount-rdv-group:'

/**
 * 由 nodeHash 派生节点 rendezvous topic。
 * @param {string} nodeHash 节点 64 hex
 * @returns {string} rendezvous topic 哈希
 */
export function nodeRendezvousTopic(nodeHash) {
	return sha256Hex(`${NODE_TOPIC_DOMAIN}${normalizeHex64(nodeHash)}`)
}

/**
 * 由房间密钥派生群组 rendezvous topic。
 * @param {string} roomSecret 房间密钥
 * @returns {string} rendezvous topic 哈希
 */
export function groupRendezvousTopic(roomSecret) {
	return sha256Hex(`${GROUP_TOPIC_DOMAIN}${String(roomSecret || '')}`)
}

/**
 * 由 topic 派生信令 AES 密钥。
 * @param {string} topic rendezvous 主题
 * @returns {Buffer} AES-256 密钥
 */
function signalKeyForTopic(topic) {
	return createHash('sha256').update(`${SIGNAL_DOMAIN}:${String(topic)}`).digest()
}

/**
 * 加密信令包为 AES-GCM 字节序列。
 * @param {string} topic rendezvous 主题
 * @param {unknown} packet 待加密 JSON 对象
 * @returns {Uint8Array} 加密后的字节
 */
export function encryptSignalPacket(topic, packet) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', signalKeyForTopic(topic), iv)
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
 * 解密信令包；失败时返回 null。
 * @param {string} topic rendezvous 主题
 * @param {Uint8Array} bytes 加密字节
 * @returns {object | null} 解密后的 JSON 对象
 */
export function decryptSignalPacket(topic, bytes) {
	try {
		const payload = JSON.parse(Buffer.from(bytes).toString('utf8'))
		const decipher = createDecipheriv(
			'aes-256-gcm',
			signalKeyForTopic(topic),
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
