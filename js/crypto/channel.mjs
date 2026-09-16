/**
 * Domain-key 信封：X25519 ECIES 包装与 AES-GCM 消息载荷（wire scheme：channel-key）。
 * 解密 payload 不可脱离外层 DAG Ed25519 签名上下文单独传递或信任。
 */
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/** @type {'channel-key'} 频道消息 content 加密 scheme */
export const CHANNEL_KEY_SCHEME = 'channel-key'

/**
 * 生成随机 32 字节频道密钥（hex）。
 * @returns {string} 32 字节 hex 频道密钥
 */
export function generateChannelKey() {
	return randomBytes(32).toString('hex')
}

/**
 * @param {string} channelKeyHex K_ch
 * @param {string} channelId 频道 id（AAD 盐）
 * @param {number} generation 代际
 * @returns {Buffer} 消息 AES-256 密钥
 */
function messageAesKey(channelKeyHex, channelId, generation) {
	return Buffer.from(hkdfSync(
		'sha256',
		Buffer.from(channelKeyHex, 'hex'),
		`${CHANNEL_KEY_SCHEME}:${channelId}:${generation}`,
		'',
		32,
	))
}

/**
 * @param {string} plaintext UTF-8 / JSON 字符串
 * @param {string} channelKeyHex K_ch
 * @param {string} channelId 频道 ID
 * @param {number} generation 密钥代际
 * @returns {{ scheme: typeof CHANNEL_KEY_SCHEME, channelId: string, generation: number, payload: string }} 频道密钥信封
 */
export function encryptWithChannelKey(plaintext, channelKeyHex, channelId, generation) {
	const key = messageAesKey(channelKeyHex, channelId, generation)
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const plain = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8')
	const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
	const authTag = cipher.getAuthTag()
	return {
		scheme: CHANNEL_KEY_SCHEME,
		channelId,
		generation: Number(generation) || 0,
		payload: `${iv.toString('base64')}.${ciphertext.toString('base64')}.${authTag.toString('base64')}`,
	}
}

/**
 * @param {{ scheme?: string, channelId?: string, generation?: number, payload: string }} envelope 频道密钥信封
 * @param {string} channelKeyHex K_ch
 * @param {string} channelId 频道 ID
 * @returns {string | null} 明文 UTF-8
 */
export function decryptWithChannelKey(envelope, channelKeyHex, channelId) {
	if (envelope?.scheme !== CHANNEL_KEY_SCHEME || !envelope.payload) return null
	try {
		const parts = envelope.payload.split('.')
		if (parts.length !== 3) return null
		const generation = Number(envelope.generation) || 0
		const key = messageAesKey(channelKeyHex, channelId, generation)
		const iv = Buffer.from(parts[0], 'base64')
		const ciphertext = Buffer.from(parts[1], 'base64')
		const authTag = Buffer.from(parts[2], 'base64')
		const decipher = createDecipheriv('aes-256-gcm', key, iv)
		decipher.setAuthTag(authTag)
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
	}
	catch { return null }
}
