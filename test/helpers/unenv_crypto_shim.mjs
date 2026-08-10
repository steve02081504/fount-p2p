/**
 * 模拟 esm.sh/unenv：createHash 在调用时抛错，其余 builtin 透传。
 * 配合 unenv_crypto_hooks 替换 `node:crypto`。
 */
const real = process.getBuiltinModule('crypto')

export function createHash() {
	throw new Error('[unenv] crypto.createHash is not implemented yet!')
}

export const {
	createCipheriv,
	createDecipheriv,
	createHmac,
	createPrivateKey,
	createPublicKey,
	hkdfSync,
	randomBytes,
	randomUUID,
	sign,
	verify,
} = real

export default {
	...real,
	createHash,
}
