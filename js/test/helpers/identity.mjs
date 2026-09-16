import { Buffer } from 'node:buffer'

import { keyPairFromSeed, pubKeyHash } from '../../crypto/crypto.mjs'

/**
 * 从固定 seed 生成测试身份。
 * @param {number} fill seed 填充字节值
 * @returns {{ nodeHash: string, nodePubKey: string, secretKey: Uint8Array }} 节点身份
 */
export function identity(fill) {
	const { publicKey, secretKey } = keyPairFromSeed(Buffer.alloc(32, fill))
	return {
		nodeHash: pubKeyHash(publicKey),
		nodePubKey: Buffer.from(publicKey).toString('hex'),
		secretKey,
	}
}
