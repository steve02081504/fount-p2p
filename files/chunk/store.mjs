import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { isHex64 } from '../../core/hexIds.mjs'
import { getNodeDir } from '../../node/instance.mjs'
import { trackFileStream } from '../../node/handles.mjs'

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
	const filePath = chunkStorePath(hash)
	await fsp.mkdir(dirname(filePath), { recursive: true })
	await fsp.writeFile(filePath, Buffer.from(data))
}

/**
 * @param {string} hash 64 位十六进制
 * @param {import('node:stream').Readable} readable 密文流
 * @returns {Promise<void>}
 */
export async function putChunkFromStream(hash, readable) {
	const filePath = chunkStorePath(hash)
	await fsp.mkdir(dirname(filePath), { recursive: true })
	await pipeline(readable, trackFileStream(fs.createWriteStream(filePath)))
}
