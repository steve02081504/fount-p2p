/**
 * 模拟 esm.sh/unenv：createHash 在调用时抛错，其余 builtin 透传。
 * 配合 unenv_crypto_hooks 替换 `node:crypto`。
 */
const real = process.getBuiltinModule('crypto')

/** @returns {never} unenv 下 createHash 未实现，调用即抛错 */
export function createHash() {
	throw new Error('[unenv] crypto.createHash is not implemented yet!')
}

/** 其余 node:crypto API 透传真实 builtin。 */
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

/** 默认导出：全量 builtin，但 createHash 替换为抛错桩。 */
export default {
	...real,
	createHash,
}
