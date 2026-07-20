import { randomBytes } from 'node:crypto'

import { bytesToHex, hexToBytes, toBytes } from '../core/bytes_codec.mjs'

/** 二进制帧协议版本号。 */
export const FRAME_VERSION = 1
/** frameId 字段字节长度（128 位）。 */
export const FRAME_ID_BYTES = 16
/** 帧头：version(1) + frameId(16) + seq(4) + total(4)。 */
export const FRAME_HEADER_BYTES = 1 + FRAME_ID_BYTES + 4 + 4
/** 默认单帧最大 chunk 大小（15 KiB）。 */
export const DEFAULT_MAX_FRAME_CHUNK_BYTES = 15 * 1024
/** 重组后消息最大字节数（8 MiB）。 */
export const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
/** 同时进行中的分片消息数量上限。 */
export const DEFAULT_MAX_PARTIAL_MESSAGES = 32
/** 分片消息超时时间（毫秒）。 */
export const DEFAULT_PARTIAL_TIMEOUT_MS = 30_000

/**
 * @param {string | Uint8Array} frameId hex 或 16 字节
 * @returns {Uint8Array} 规范化后的 16 字节 frameId
 */
function normalizeFrameIdBytes(frameId) {
	if (frameId instanceof Uint8Array) {
		if (frameId.byteLength !== FRAME_ID_BYTES)
			throw new Error(`p2p: frameId must be ${FRAME_ID_BYTES} bytes`)
		return frameId
	}
	const text = frameId.trim().toLowerCase()
	if (text.length !== FRAME_ID_BYTES * 2)
		throw new Error('p2p: frameId must be 32 hex characters')
	try {
		return hexToBytes(text)
	}
	catch {
		throw new Error('p2p: frameId must be 32 hex characters')
	}
}

/** @returns {string} 32 字符 hex frameId */
export function randomFrameIdHex() {
	return bytesToHex(randomBytes(FRAME_ID_BYTES))
}

/**
 * 将消息切成带帧头的分片。
 * @param {string | Uint8Array} frameId 消息 id（hex 或 16 字节）
 * @param {Uint8Array | ArrayBuffer | ArrayBufferView} bytes 消息体
 * @param {number} [maxChunkBytes] 单片上限
 * @returns {Uint8Array[]} 分片帧列表
 */
export function encodeFrames(frameId, bytes, maxChunkBytes = DEFAULT_MAX_FRAME_CHUNK_BYTES) {
	const body = toBytes(bytes)
	const idBytes = normalizeFrameIdBytes(frameId)
	const chunkBytes = Math.max(256, Math.min(DEFAULT_MAX_MESSAGE_BYTES, Number(maxChunkBytes) || DEFAULT_MAX_FRAME_CHUNK_BYTES))
	const total = Math.max(1, Math.ceil(body.byteLength / chunkBytes))
	/** @type {Uint8Array[]} */
	const frames = []
	for (let seq = 0; seq < total; seq++) {
		const start = seq * chunkBytes
		const end = Math.min(body.byteLength, start + chunkBytes)
		const chunk = body.subarray(start, end)
		const frame = new Uint8Array(FRAME_HEADER_BYTES + chunk.byteLength)
		frame[0] = FRAME_VERSION
		frame.set(idBytes, 1)
		const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
		view.setUint32(1 + FRAME_ID_BYTES, seq, false)
		view.setUint32(1 + FRAME_ID_BYTES + 4, total, false)
		frame.set(chunk, FRAME_HEADER_BYTES)
		frames.push(frame)
	}
	return frames
}

/**
 * 解析单帧头与 chunk。
 * @param {Uint8Array | ArrayBuffer | ArrayBufferView} frame 原始帧
 * @returns {{ version: number, frameId: string, seq: number, total: number, chunk: Uint8Array }} 帧字段
 */
export function decodeFrame(frame) {
	const bytes = toBytes(frame)
	if (bytes.byteLength < FRAME_HEADER_BYTES)
		throw new Error('p2p: frame too short')
	const version = bytes[0]
	if (version !== FRAME_VERSION)
		throw new Error(`p2p: unsupported frame version ${version}`)
	const frameId = bytesToHex(bytes.subarray(1, 1 + FRAME_ID_BYTES))
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const seq = view.getUint32(1 + FRAME_ID_BYTES, false)
	const total = view.getUint32(1 + FRAME_ID_BYTES + 4, false)
	if (!total || seq >= total)
		throw new Error('p2p: invalid frame sequence')
	return {
		version,
		frameId,
		seq,
		total,
		chunk: bytes.subarray(FRAME_HEADER_BYTES),
	}
}

/**
 * @param {Uint8Array[]} chunks 有序分片
 * @returns {Uint8Array} 拼接结果
 */
function concatChunks(chunks) {
	const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
	const out = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.byteLength
	}
	return out
}

/**
 * 创建分片重组器（按 frameId 聚合，超时 prune）。
 * @param {{ maxMessageBytes?: number, maxPartials?: number, partialTimeoutMs?: number }} [options] 上限与超时
 * @returns {{ push: (frame: Uint8Array | ArrayBuffer | ArrayBufferView, now?: number) => Uint8Array | null, prune: (now?: number) => string[], clear: () => void, size: () => number }} 重组 API
 */
export function createReassembler(options = {}) {
	const maxMessageBytes = Math.max(1024, Number(options.maxMessageBytes) || DEFAULT_MAX_MESSAGE_BYTES)
	const maxPartials = Math.max(1, Number(options.maxPartials) || DEFAULT_MAX_PARTIAL_MESSAGES)
	const partialTimeoutMs = Math.max(1000, Number(options.partialTimeoutMs) || DEFAULT_PARTIAL_TIMEOUT_MS)
	/** @type {Map<string, { total: number, remaining: number, chunks: Uint8Array[], bytes: number, firstSeenAt: number, lastSeenAt: number }>} */
	const partials = new Map()

	return {
		/**
		 * 喂入一帧；凑齐则返回完整消息，否则 null。
		 * @param {Uint8Array | ArrayBuffer | ArrayBufferView} frame 原始帧
		 * @param {number} [now] 当前时间戳（测试可注入）
		 * @returns {Uint8Array | null} 完整消息或尚未齐
		 */
		push(frame, now = Date.now()) {
			const parsed = decodeFrame(frame)
			if (!partials.has(parsed.frameId) && partials.size >= maxPartials)
				throw new Error('p2p: too many partial messages')
			let partial = partials.get(parsed.frameId)
			if (!partial) {
				partial = {
					total: parsed.total,
					remaining: parsed.total,
					chunks: new Array(parsed.total),
					bytes: 0,
					firstSeenAt: now,
					lastSeenAt: now,
				}
				partials.set(parsed.frameId, partial)
			}
			if (partial.total !== parsed.total) {
				partials.delete(parsed.frameId)
				throw new Error('p2p: frame total mismatch')
			}
			partial.lastSeenAt = now
			if (!partial.chunks[parsed.seq]) {
				partial.chunks[parsed.seq] = parsed.chunk
				partial.remaining--
				partial.bytes += parsed.chunk.byteLength
				if (partial.bytes > maxMessageBytes) {
					partials.delete(parsed.frameId)
					throw new Error('p2p: reassembled message exceeds limit')
				}
			}
			if (partial.remaining === 0) {
				const out = concatChunks(partial.chunks)
				partials.delete(parsed.frameId)
				return out
			}
			return null
		},
		/**
		 * 丢弃超时未齐的分片。
		 * @param {number} [now] 当前时间戳
		 * @returns {string[]} 被丢弃的 frameId 列表
		 */
		prune(now = Date.now()) {
			/** @type {string[]} */
			const expired = []
			for (const [frameId, partial] of partials)
				if (now - partial.lastSeenAt > partialTimeoutMs) {
					expired.push(frameId)
					partials.delete(frameId)
				}
			return expired
		},
		/** @returns {void} */
		clear() {
			partials.clear()
		},
		/** @returns {number} 进行中的分片消息数 */
		size() {
			return partials.size
		},
	}
}
