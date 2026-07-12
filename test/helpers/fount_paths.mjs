import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { where_command } from '@steve02081504/exec'

/** @type {string | null} */
let cachedFountRoot = null

/**
 * 经 PATH 上 `fount` 可执行文件解析仓库根目录。
 * `.../fount/path/fount` → `.../fount`（与 fount.sh 中 FOUNT_DIR 一致）。
 *
 * @returns {Promise<string>} 绝对路径
 */
export async function resolveFountRoot() {
	if (cachedFountRoot) return cachedFountRoot
	const fountPath = await where_command('fount')
	if (!fountPath)
		throw new Error('fount not on PATH')
	const real = await realpath(fountPath)
	cachedFountRoot = dirname(dirname(real))
	return cachedFountRoot
}

/**
 * @returns {Promise<string | false>} `node:test` skip 原因；可用时返回 false
 */
export async function fountSkipReason() {
	try {
		await resolveFountRoot()
		return false
	}
	catch (error) {
		return error instanceof Error ? error.message : 'fount unavailable'
	}
}

/**
 * @param {...string} segments `src/scripts/p2p` 下相对路径
 * @returns {Promise<Record<string, unknown>>} 动态导入的模块命名空间
 */
export async function importFountP2pScript(...segments) {
	const root = await resolveFountRoot()
	const file = join(root, 'src/scripts/p2p', ...segments)
	return import(pathToFileURL(file).href)
}

/**
 * @param {...string} segments `social/src` 下相对路径
 * @returns {Promise<Record<string, unknown>>} 动态导入的模块命名空间
 */
export async function importSocialModule(...segments) {
	const root = await resolveFountRoot()
	const file = join(root, 'src/public/parts/shells/social/src', ...segments)
	return import(pathToFileURL(file).href)
}

/**
 * @param {...string} segments `public/pages/scripts/p2p` 下相对路径
 * @returns {Promise<Record<string, unknown>>} 动态导入的模块命名空间
 */
export async function importPagesP2pModule(...segments) {
	const root = await resolveFountRoot()
	const file = join(root, 'src/public/pages/scripts/p2p', ...segments)
	return import(pathToFileURL(file).href)
}
