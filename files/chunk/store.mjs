import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { isHex64 } from '../../core/hexIds.mjs'
import { trackFileStream } from '../../node/handles.mjs'
import { getNodeDir } from '../../node/instance.mjs'
import { withAsyncMutex } from '../../utils/async_mutex.mjs'

/** chunk store 互斥键：GC 删除与写入互斥。 */
const CHUNK_STORE_LOCK_KEY = 'chunk-store'

/**
 * chunk store 全局互斥锁（进程内）。GC 删除阶段与 `putChunk`/`putChunkFromStream` 共用，
 * 避免「GC unlink 与写入竞争」。单进程假设，不跨进程。
 * @template T
 * @param {() => Promise<T>} criticalSection 临界区
 * @returns {Promise<T>} 临界区返回值
 */
export function withChunkStoreLock(criticalSection) {
	return withAsyncMutex(CHUNK_STORE_LOCK_KEY, criticalSection)
}

/**
 * @returns {string} `{nodeDir}/chunks`
 */
export function chunkStoreRoot() {
	return join(getNodeDir(), 'chunks')
}

/**
 * @param {string} hash 64 位十六进制 ciphertextHash
 * @returns {string} 块文件绝对路径
 */
export function chunkStorePath(hash) {
	if (!isHex64(hash)) throw new Error('invalid chunk hash')
	return join(chunkStoreRoot(), hash.slice(0, 2), `${hash}.bin`)
}

/**
 * @param {string} hash 64 位十六进制
 * @returns {Promise<boolean>} 本地是否存在
 */
export async function hasChunk(hash) {
	try {
		await fsp.access(chunkStorePath(hash))
		return true
	}
	catch {
		return false
	}
}

/**
 * @param {string} hash 64 位十六进制
 * @returns {Promise<Buffer>} 块字节
 */
export async function getChunk(hash) {
	return fsp.readFile(chunkStorePath(hash))
}

/**
 * @param {string} hash 64 位十六进制
 * @returns {import('node:fs').ReadStream} 可读流
 */
export function createChunkReadStream(hash) {
	return trackFileStream(fs.createReadStream(chunkStorePath(hash)))
}

/**
 * @param {string} hash 64 位十六进制
 * @param {string | Buffer | Uint8Array} data 块数据
 * @returns {Promise<void>}
 */
export async function putChunk(hash, data) {
	return withChunkStoreLock(() => writeChunkFile(hash, Buffer.from(data)))
}

/**
 * @param {string} hash 64 位十六进制
 * @param {import('node:stream').Readable} readable 密文流
 * @returns {Promise<void>}
 */
export async function putChunkFromStream(hash, readable) {
	return withChunkStoreLock(async () => {
		const filePath = chunkStorePath(hash)
		await fsp.mkdir(dirname(filePath), { recursive: true })
		await pipeline(readable, trackFileStream(fs.createWriteStream(filePath)))
	})
}

/**
 * @param {string} hash 64 位十六进制
 * @param {string | Buffer | Uint8Array} data 块数据
 * @returns {Promise<void>} 直接写文件（无锁；调用方须持 `withChunkStoreLock`）
 */
async function writeChunkFile(hash, data) {
	const filePath = chunkStorePath(hash)
	await fsp.mkdir(dirname(filePath), { recursive: true })
	await fsp.writeFile(filePath, data)
}

/**
 * @param {string} hash 64 位十六进制
 * @returns {Promise<{ deleted: boolean, size: number }>} 删除结果；`deleted:false` 表示仍在被读（Windows open-handle）
 */
export async function unlinkChunkFile(hash) {
	const filePath = chunkStorePath(hash)
	try {
		const { size } = await fsp.stat(filePath)
		await fsp.unlink(filePath)
		return { deleted: true, size }
	}
	catch (error) {
		const code = /** @type {NodeJS.ErrnoException} */ error.code
		if (code === 'ENOENT') return { deleted: true, size: 0 }
		// Windows 上文件被读流打开时 unlink 会 EBUSY/EPERM——视为仍在使用，留给下次 GC。
		if (code === 'EBUSY' || code === 'EPERM') return { deleted: false, size: 0 }
		throw error
	}
}

/**
 * 删除单个 chunk（带互斥锁）。重复删除视为成功。
 * @param {string} hash 64 位十六进制
 * @returns {Promise<{ deleted: boolean, size: number }>} 删除结果
 */
export async function deleteChunk(hash) {
	return withChunkStoreLock(() => unlinkChunkFile(hash))
}
