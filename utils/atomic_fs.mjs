/**
 * 原子落盘：唯一临时路径 + rename（Windows 短暂占用时短退避重试）。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

/** Windows 上 rename 可能被短暂占用，做几次短退避重试。 */
const ATOMIC_RENAME_RETRY_DELAYS_MS = [0, 10, 25, 50, 100]
const ATOMIC_RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * @param {string} filePath 目标路径
 * @returns {string} 唯一临时文件路径
 */
export function atomicTemporaryPath(filePath) {
	return `${filePath}.tmp.${process.pid}.${randomUUID()}`
}

/**
 * @param {string} temporaryPath 临时文件路径
 * @returns {Promise<void>}
 */
async function cleanupAtomicTemporary(temporaryPath) {
	try { await unlink(temporaryPath) } catch { /* ok */ }
}

/**
 * @param {string} temporaryPath 临时文件路径
 * @returns {void}
 */
function cleanupAtomicTemporarySync(temporaryPath) {
	try { fs.unlinkSync(temporaryPath) } catch { /* ok */ }
}

/**
 * 完成原子写的最终 rename；若目标目录已在 cleanup 中消失，则清理残余临时文件后静默返回。
 * @param {string} temporaryPath 临时文件路径
 * @param {string} filePath 最终目标路径
 * @returns {Promise<boolean>} 是否已成功落到目标路径
 */
export async function finalizeAtomicRename(temporaryPath, filePath) {
	/** @type {NodeJS.ErrnoException | undefined} */
	let lastError
	for (const delayMs of ATOMIC_RENAME_RETRY_DELAYS_MS) {
		if (delayMs) await sleep(delayMs)
		try {
			await rename(temporaryPath, filePath)
			return true
		}
		catch (error) {
			lastError = error
			if (ATOMIC_RENAME_RETRY_CODES.has(error?.code)) continue
			break
		}
	}
	await cleanupAtomicTemporary(temporaryPath)
	if (lastError?.code === 'ENOENT') return false
	throw lastError
}

/**
 * `finalizeAtomicRename` 的同步版。
 * @param {string} temporaryPath 临时文件路径
 * @param {string} filePath 最终目标路径
 * @returns {boolean} 是否已成功落到目标路径
 */
export function finalizeAtomicRenameSync(temporaryPath, filePath) {
	/** @type {NodeJS.ErrnoException | undefined} */
	let lastError
	for (const delayMs of ATOMIC_RENAME_RETRY_DELAYS_MS) {
		if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
		try {
			fs.renameSync(temporaryPath, filePath)
			return true
		}
		catch (error) {
			lastError = error
			if (ATOMIC_RENAME_RETRY_CODES.has(error?.code)) continue
			break
		}
	}
	cleanupAtomicTemporarySync(temporaryPath)
	if (lastError?.code === 'ENOENT') return false
	throw lastError
}
