import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

import { FEDERATION_CHUNK_MAX_BYTES } from '../core/constants.mjs'

import { encryptSliceToPart } from './assemble.mjs'
import { decryptPart } from './transfer_key.mjs'

/**
 * @typedef {import('./manifest.mjs').CeMode} CeMode
 * @typedef {{ hash: string, size: number, raw: Buffer, contentHash?: string }} EncryptedPart
 */

/**
 * 从可读流分块加密并流式落盘（每块经 onPart 回调）。
 * @param {import('node:stream').Readable} readable 明文流
 * @param {CeMode} [ceMode] 加密模式
 * @param {(part: EncryptedPart) => Promise<void>} onPart 每块回调
 * @param {number} [maxBytes] 最大字节
 * @returns {Promise<{ contentHash: string, parts: Array<{ hash: string, size: number, contentHash?: string }>, contentKey?: Buffer }>} 分块结果
 */
export async function encryptReadableToParts(readable, ceMode = 'convergent', onPart, maxBytes = Infinity) {
	const digest = createHash('sha256')
	/** @type {Buffer[]} */
	let pending = Buffer.alloc(0)
	/** @type {Array<{ hash: string, size: number, contentHash?: string }>} */
	const parts = []
	const contentKey = ceMode === 'random' ? randomBytes(32) : null
	let total = 0

	/**
	 * @param {Buffer} slice 明文块
	 * @returns {Promise<void>}
	 */
	const flushSlice = async (slice) => {
		digest.update(slice)
		const part = encryptSliceToPart(slice, ceMode, contentKey)
		/** @type {{ hash: string, size: number, contentHash?: string }} */
		const meta = { hash: part.hash, size: part.size }
		if (part.contentHash) meta.contentHash = part.contentHash
		parts.push(meta)
		await onPart(part)
	}

	for await (const chunk of readable) {
		const buffer = Buffer.from(chunk)
		total += buffer.length
		if (total > maxBytes)
			throw new Error('plaintext exceeds max upload size')
		pending = Buffer.concat([pending, buffer])
		while (pending.length >= FEDERATION_CHUNK_MAX_BYTES) {
			const slice = pending.subarray(0, FEDERATION_CHUNK_MAX_BYTES)
			pending = pending.subarray(FEDERATION_CHUNK_MAX_BYTES)
			await flushSlice(slice)
		}
	}

	if (pending.length)
		await flushSlice(pending)

	return {
		contentHash: digest.digest('hex'),
		parts,
		contentKey: contentKey || undefined,
	}
}

/**
 * @param {import('node:stream').Readable} stream 密文流
 * @returns {Promise<Buffer | null>} 下一可读块；流结束为 null
 */
function readStreamChunk(stream) {
	const chunk = stream.read()
	if (chunk) return Promise.resolve(Buffer.from(chunk))
	if (stream.readableEnded) return Promise.resolve(null)
	return new Promise((resolve, reject) => {
		/**
		 *
		 */
		const onReadable = () => {
			cleanup()
			const next = stream.read()
			resolve(next ? Buffer.from(next) : Buffer.alloc(0))
		}
		/**
		 *
		 */
		const onEnd = () => {
			cleanup()
			resolve(null)
		}
		/**
		 * @param {Error} error 错误
		 */
		const onError = error => {
			cleanup()
			reject(error)
		}
		/**
		 *
		 */
		const cleanup = () => {
			stream.off('readable', onReadable)
			stream.off('end', onEnd)
			stream.off('error', onError)
		}
		stream.once('readable', onReadable)
		stream.once('end', onEnd)
		stream.once('error', onError)
	})
}

/**
 * 将 manifest 各密文块按 part.size 拼齐后解密，串联为明文可读流。
 * @param {import('./manifest.mjs').FileManifest} manifest 清单
 * @param {import('node:stream').Readable[]} partStreams 按序密文流
 * @param {Buffer | null} contentKey 随机密钥
 * @returns {Readable} 明文流
 */
export function createManifestPlaintextStream(manifest, partStreams, contentKey) {
	if (partStreams.length !== manifest.parts.length)
		throw new Error('part stream count mismatch')

	let partIndex = 0
	/** @type {Buffer} */
	let pending = Buffer.alloc(0)
	const digest = createHash('sha256')
	let finished = false

	return new Readable({
		/**
		 *
		 */
		async read() {
			if (finished) return
			try {
				while (partIndex < manifest.parts.length) {
					const need = Number(manifest.parts[partIndex].size) || 0
					const stream = partStreams[partIndex]
					while (pending.length < need) {
						const more = await readStreamChunk(stream)
						if (more === null) break
						if (more.length) pending = Buffer.concat([pending, more])
					}
					if (pending.length < need) {
						this.destroy(new Error('short ciphertext part'))
						return
					}
					const enc = pending.subarray(0, need)
					pending = pending.subarray(need)
					if (pending.length) {
						this.destroy(new Error('trailing ciphertext in part stream'))
						return
					}
					const plain = decryptPart(enc, manifest, contentKey, partIndex)
					if (!plain) {
						this.destroy(new Error('decrypt failed'))
						return
					}
					digest.update(plain)
					partIndex++
					this.push(plain)
					return
				}
				if (manifest.contentHash) {
					const got = digest.digest('hex')
					if (got !== String(manifest.contentHash).toLowerCase()) {
						this.destroy(new Error('contentHash mismatch'))
						return
					}
				}
				finished = true
				this.push(null)
			}
			catch (error) {
				this.destroy(error instanceof Error ? error : new Error(String(error)))
			}
		},
	})
}
