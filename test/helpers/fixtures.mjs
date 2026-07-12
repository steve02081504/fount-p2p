/**
 * @param {string} seedChar 单字符种子，展开为 64 hex subject
 * @returns {string} 128 位十六进制 entity hash（固定 node + subject）
 */
export function placeholderEntityHash(seedChar) {
	const node = 'a'.repeat(64)
	const subject = String(seedChar).padEnd(64, seedChar).slice(0, 64)
	return node + subject
}
