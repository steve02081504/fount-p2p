import { Buffer } from 'node:buffer'

import { keyPairFromSeed, pubKeyHash } from '../crypto/crypto.mjs'

/**
 * 由持久化 nodeSeed 派生 nodeHash（64 hex）。
 * @param {string} seedHex 32 字节 hex
 * @returns {string} 节点哈希
 */
export function nodeHashFromSeed(seedHex) {
	const seed = Buffer.from(String(seedHex).trim(), 'hex')
	if (seed.length !== 32) throw new Error('invalid node seed')
	const { publicKey } = keyPairFromSeed(seed)
	return pubKeyHash(publicKey)
}
