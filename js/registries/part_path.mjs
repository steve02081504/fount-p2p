/** @type {Map<string, string>} shell 逻辑名 → partpath */
const shellPartpaths = new Map()

/**
 * Shell Load 时注册本 part 的 partpath（P2P 层不硬编码 shells/*）。
 * @param {string} shellKey 如 social、chat
 * @param {string} partpath 如 shells/social
 * @returns {void}
 */
export function registerShellPartpath(shellKey, partpath) {
	shellPartpaths.set(shellKey, partpath)
}

/**
 * @param {string} shellKey 如 social、chat
 * @returns {void}
 */
export function unregisterShellPartpath(shellKey) {
	shellPartpaths.delete(shellKey)
}

/**
 * @param {string} shellKey 如 social
 * @returns {string} 已注册的 partpath
 */
export function getShellPartpath(shellKey) {
	const path = shellPartpaths.get(shellKey)
	if (!path) throw new Error(`shell partpath not registered: ${shellKey}`)
	return path
}
