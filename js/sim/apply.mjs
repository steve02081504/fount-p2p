/**
 * 按模块写回 tunables JSON。
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeBundle, sanitizeBundle } from './space.mjs'

/** @typedef {import('./tunables_bundle.mjs').TunablesBundle} TunablesBundle */

/** @type {Record<Exclude<keyof TunablesBundle, 'social'>, URL>} */
const PACKAGE_MODULE_URLS = {
	reputation: new URL('../reputation/tunables.json', import.meta.url),
	trustGraph: new URL('../trust_graph/tunables.json', import.meta.url),
	mailbox: new URL('../mailbox/tunables.json', import.meta.url),
	archive: new URL('../dag/tunables.json', import.meta.url),
	admission: new URL('../governance/tunables.json', import.meta.url),
}

/**
 * @param {TunablesBundle} bundle 完整 tunables
 * @returns {TunablesBundle} 写盘前规整后的 bundle
 */
export function prepareBundleForApply(bundle) {
	return sanitizeBundle(normalizeBundle(bundle))
}

/**
 * @param {string} socialTunablesPath 外部 social shell 的 reputation_social.tunables.json 绝对或相对路径
 * @returns {string} 规范化绝对路径
 */
export function resolveSocialTunablesPath(socialTunablesPath) {
	const raw = String(socialTunablesPath ?? '').trim()
	if (!raw) throw new Error('socialTunablesPath required to write social tunables')
	return path.resolve(raw)
}

/**
 * @param {keyof TunablesBundle} module 模块键
 * @param {Record<string, unknown>} data JSON 内容
 * @param {string} [socialTunablesPath] social 模块写入路径（module === 'social' 时必填）
 * @returns {Promise<string>} 写入路径
 */
export async function writeModuleTunables(module, data, socialTunablesPath) {
	const filePath = module === 'social'
		? resolveSocialTunablesPath(socialTunablesPath)
		: fileURLToPath(PACKAGE_MODULE_URLS[module])
	await writeFile(filePath, `${JSON.stringify(data, null, '\t')}\n`, 'utf8')
	return filePath
}

/**
 * @param {TunablesBundle} bundle 完整 tunables
 * @param {{ socialTunablesPath: string }} paths 外部模块路径（social 写回 shell 侧 JSON）
 * @returns {Promise<string[]>} 各模块 JSON 写入路径
 */
export async function applyTunablesBundle(bundle, paths) {
	const socialPath = resolveSocialTunablesPath(paths?.socialTunablesPath)
	const ready = prepareBundleForApply(bundle)
	const written = []
	written.push(await writeModuleTunables('reputation', ready.reputation))
	written.push(await writeModuleTunables('trustGraph', ready.trustGraph))
	written.push(await writeModuleTunables('social', ready.social, socialPath))
	written.push(await writeModuleTunables('mailbox', ready.mailbox))
	written.push(await writeModuleTunables('archive', ready.archive))
	written.push(await writeModuleTunables('admission', ready.admission))
	return written
}

/**
 * @param {string} [dir] sim 目录（默认本模块目录）
 * @returns {string} results 子目录绝对路径
 */
export function resultsDirFromSim(dir = path.dirname(fileURLToPath(import.meta.url))) {
	return path.join(dir, 'results')
}
