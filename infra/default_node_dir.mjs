import os from 'node:os'
import path from 'node:path'

/**
 * @returns {string} 平台默认 node 数据目录
 */
export function defaultNodeDir() {
	if (process.platform === 'win32') {
		const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
		return path.join(base, 'fount-p2p', 'node')
	}
	return path.join(os.homedir(), '.local', 'share', 'fount-p2p', 'node')
}

/**
 * @param {string | undefined} override - CLI 或调用方覆盖
 * @returns {string} 解析后的绝对 node 目录
 */
export function resolveNodeDir(override) {
	const trimmed = String(override || '').trim()
	return trimmed ? path.resolve(trimmed) : defaultNodeDir()
}
