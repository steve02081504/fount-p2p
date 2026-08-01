import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { atomicTemporaryPath, finalizeAtomicRename, finalizeAtomicRenameSync } from './atomic_fs.mjs'

/**
 * @param {string} filePath 绝对路径
 * @returns {Promise<object | null>} JSON 或 null
 */
export async function readJsonFile(filePath) {
	try {
		const raw = await fsp.readFile(filePath, 'utf8')
		return JSON.parse(raw)
	}
	catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ error.code === 'ENOENT') return null
		throw error
	}
}

/**
 * @param {string} filePath 绝对路径
 * @param {unknown} data 可序列化对象
 * @returns {Promise<void>}
 */
export async function writeJsonFile(filePath, data) {
	await fsp.mkdir(path.dirname(filePath), { recursive: true })
	const temporaryPath = atomicTemporaryPath(filePath)
	await fsp.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
	if (!await finalizeAtomicRename(temporaryPath, filePath))
		throw Object.assign(new Error(`ENOENT: atomic rename failed for ${filePath}`), { code: 'ENOENT' })
}

/**
 * @param {string} filePath 绝对路径
 * @returns {object | null} JSON 或 null
 */
export function readJsonFileSync(filePath) {
	try {
		const raw = fs.readFileSync(filePath, 'utf8')
		return JSON.parse(raw)
	}
	catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ error.code === 'ENOENT') return null
		throw error
	}
}

/**
 * @param {string} filePath 绝对路径
 * @param {unknown} data 可序列化对象
 * @returns {void}
 */
export function writeJsonFileSync(filePath, data) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	const temporaryPath = atomicTemporaryPath(filePath)
	fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
	if (!finalizeAtomicRenameSync(temporaryPath, filePath))
		throw Object.assign(new Error(`ENOENT: atomic rename failed for ${filePath}`), { code: 'ENOENT' })
}
