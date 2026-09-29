import { Buffer } from 'node:buffer'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { withAsyncMutex } from '../utils/async_mutex.mjs'
import { atomicTemporaryPath, finalizeAtomicRename } from '../utils/atomic_fs.mjs'

/** 流式重写 JSONL 时分块写入的行数上限 */
const WRITE_JSONL_CHUNK_LINES = 1000

/**
 * @param {string} line JSONL 单行
 * @param {(row: object) => object} sanitize 行净化
 * @returns {object | null} 解析后的对象；坏行/空行返回 null
 */
function parseJsonlLine(line, sanitize) {
	const trimmed = String(line).trim()
	if (!trimmed) return null
	try {
		return sanitize(JSON.parse(trimmed))
	}
	catch {
		return null
	}
}

/**
 * 逐行读取 JSONL 原始行（不解析、不净化）。文件缺失（ENOENT）视为空流，
 * 兼容 cleanup 竞态：群目录被删后台仍在尾巴上读它；其他读错误抛出。
 * @param {string} filePath 文件路径
 * @returns {AsyncGenerator<string>} 原始行（readline 已去掉行尾换行）
 */
async function* readJsonlRawLines(filePath) {
	const input = createReadStream(filePath, { encoding: 'utf8' })
	// stream 内部异步 open 失败会触发 'error' 事件；提前订阅避免 unhandled error，
	// 真实错误仍由下方 for-await 抛出，由本函数统一收口。
	input.on('error', () => { })
	const lines = createInterface({ input, crlfDelay: Infinity })
	try {
		for await (const line of lines) yield line
	}
	catch (error) {
		if (error?.code !== 'ENOENT') throw error
	}
}

/**
 * 读取 JSONL 为 `{ row, raw }` 列表，保留原始行以便无损写回。
 * 空行/解析失败/净化抛错的行跳过；文件缺失（ENOENT）返回空数组，其他读错误抛出。
 * @param {string} filePath 文件路径
 * @param {{ sanitize?: (row: object) => object }} [options] 行净化
 * @returns {Promise<Array<{ row: object, raw: string }>>} 行条目列表
 */
export async function readJsonlEntries(filePath, options = {}) {
	const sanitize = options.sanitize ?? (row => row)
	/** @type {Array<{ row: object, raw: string }>} */
	const entries = []
	for await (const raw of readJsonlRawLines(filePath)) {
		const row = parseJsonlLine(raw, sanitize)
		if (row != null) entries.push({ row, raw })
	}
	return entries
}

/**
 * 读取 JSONL 文件并解析为对象数组；缺失（ENOENT）返回空数组，其他读错误抛出。
 * @param {string} filePath 文件系统路径
 * @param {{ sanitize?: (row: object) => object }} [options] 可选净化函数
 * @returns {Promise<object[]>} 各行解析后的对象列表
 */
export async function readJsonl(filePath, options = {}) {
	const entries = await readJsonlEntries(filePath, options)
	return entries.map(entry => entry.row).filter(Boolean)
}

/**
 * 流式读取 JSONL（避免整文件读入内存）。文件缺失（ENOENT）视为空流，
 * 兼容 cleanup 竞态：群目录被删后台仍在尾巴上读它。
 * @param {string} filePath 文件路径
 * @param {{ sanitize?: (row: object) => object }} [options] 行净化
 * @returns {AsyncGenerator<object>} 逐行事件
 */
export async function* readJsonlStream(filePath, options = {}) {
	const sanitize = options.sanitize ?? (row => row)
	for await (const line of readJsonlRawLines(filePath)) {
		const row = parseJsonlLine(line, sanitize)
		if (row) yield row
	}
}

/**
 * 流式过滤重写 JSONL：保留 `keep(row)===true` 的行，写回的是原始行字节，
 * `sanitize` 只影响传给 `keep` 的值。
 *
 * 在 `jsonlMutexKey(filePath)` 互斥锁内执行；调用方不得已持有同一文件的锁（不可重入）。
 * @param {string} filePath 目标路径
 * @param {(row: object) => boolean | Promise<boolean>} keep 保留谓词（可异步）
 * @param {{ sanitize?: (row: object) => object }} [options] 读行净化
 * @returns {Promise<{ kept: number, dropped: number }>} 统计
 */
export async function rewriteJsonlKeeping(filePath, keep, options = {}) {
	return withAsyncMutex(jsonlMutexKey(filePath), () => rewriteJsonlKeepingUnlocked(filePath, keep, options))
}

/**
 * `rewriteJsonlKeeping` 的无锁实现，调用方须已持有该文件互斥锁。
 * @param {string} filePath 目标路径
 * @param {(row: object) => boolean | Promise<boolean>} keep 保留谓词（可异步）
 * @param {{ sanitize?: (row: object) => object }} [options] 读行净化
 * @returns {Promise<{ kept: number, dropped: number }>} 统计
 */
async function rewriteJsonlKeepingUnlocked(filePath, keep, options = {}) {
	const sanitize = options.sanitize ?? (row => row)
	const temporaryPath = atomicTemporaryPath(filePath)
	let tempCreated = false
	/** @type {string[]} */
	const buffer = []
	let kept = 0
	let dropped = 0
	/** @returns {Promise<void>} 将缓冲区原始行写入临时文件 */
	const flush = async () => {
		if (!buffer.length) return
		const block = buffer.map(line => `${line}\n`).join('')
		await appendFile(temporaryPath, block, 'utf8')
		tempCreated = true
		buffer.length = 0
	}
	try {
		for await (const raw of readJsonlRawLines(filePath)) {
			if (!raw.trim()) continue
			const row = parseJsonlLine(raw, sanitize)
			if (row == null) {
				dropped++
				continue
			}
			if (await keep(row)) {
				buffer.push(raw)
				kept++
				if (buffer.length >= WRITE_JSONL_CHUNK_LINES) await flush()
			}
			else dropped++
		}
		await flush()
		if (dropped === 0) {
			if (tempCreated) await unlink(temporaryPath).catch(() => { })
			return { kept, dropped }
		}
		await mkdir(dirname(filePath), { recursive: true })
		if (!tempCreated) {
			await writeFile(temporaryPath, '', 'utf8')
			tempCreated = true
		}
		const fileHandle = await open(temporaryPath, 'r+')
		try {
			await fileHandle.sync()
		}
		finally {
			await fileHandle.close()
		}
		await finalizeAtomicRename(temporaryPath, filePath)
		return { kept, dropped }
	}
	catch (error) {
		if (tempCreated) await unlink(temporaryPath).catch(() => { })
		throw error
	}
}

/**
 * 读取 JSONL 末条可解析事件的 `id`（DAG tip）；从文件尾部最多读 1 MiB，
 * 跳过撕裂/坏行后取最后一个非空且 `id` 非 null 的行；空文件或缺失为 null。
 * @param {string} filePath 文件路径
 * @returns {Promise<string | null>} tip event id
 */
export async function readJsonlTipId(filePath) {
	try {
		const fh = await open(filePath, 'r')
		try {
			const { size } = await fh.stat()
			if (!size) return null
			const chunk = Math.min(size, 1_048_576)
			const buffer = Buffer.alloc(chunk)
			await fh.read(buffer, 0, chunk, size - chunk)
			const lines = buffer.toString('utf8').split('\n')
			for (let index = lines.length - 1; index >= 0; index--) {
				const line = lines[index].trim()
				if (!line) continue
				try {
					const row = JSON.parse(line)
					if (row && typeof row === 'object' && row.id != null) return String(row.id)
				}
				catch { /* 撕裂/坏行：继续向前找 */ }
			}
			return null
		}
		finally {
			await fh.close()
		}
	}
	catch {
		return null
	}
}

/**
 * 流式写入原始 JSONL 行（临时文件 + fsync + rename），每行自动补 `\n`。
 * 不取锁——调用方需自行持有 `jsonlMutexKey(filePath)`。
 * @param {string} filePath 目标路径
 * @param {Iterable<string>} lines 原始行（不含换行）
 * @returns {Promise<void>}
 */
export async function writeJsonlLines(filePath, lines) {
	const dir = dirname(filePath)
	await mkdir(dir, { recursive: true })
	const temporaryPath = atomicTemporaryPath(filePath)
	/** @returns {Generator<string>} 带换行的行 */
	function* withEol() {
		for (const line of lines)
			yield `${line}\n`
	}
	await pipeline(Readable.from(withEol()), createWriteStream(temporaryPath, { encoding: 'utf8' }))
	const fileHandle = await open(temporaryPath, 'r+')
	try {
		await fileHandle.sync()
	}
	finally {
		await fileHandle.close()
	}
	await finalizeAtomicRename(temporaryPath, filePath)
}

/**
 * 流式重写 JSONL（临时文件 + fsync + rename），避免大数组 join 的内存峰值。
 * 不取锁——`mailbox/store.mjs` 等调用方在自己的 `jsonlMutexKey` 锁内调用；
 * 需要锁时用 `writeJsonlSynced`。
 * @param {string} filePath 目标路径
 * @param {object[]} records 行对象列表
 * @returns {Promise<void>}
 */
export async function writeJsonl(filePath, records) {
	return writeJsonlLines(filePath, records.map(record => JSON.stringify(record)))
}

/**
 * @param {string} filePath JSONL 路径
 * @returns {string} 进程内互斥键（路径已规范化为绝对路径）
 */
export function jsonlMutexKey(filePath) {
	return `jsonl:${resolve(filePath)}`
}

/**
 * 在 per-file 互斥锁内流式重写 JSONL（Social / Mailbox 等非 Chat 群锁域）。
 * @param {string} filePath 目标路径
 * @param {object[]} records 行对象列表
 * @returns {Promise<void>}
 */
export async function writeJsonlSynced(filePath, records) {
	return withAsyncMutex(jsonlMutexKey(filePath), () => writeJsonl(filePath, records))
}

/**
 * 追加一行 JSONL 并 `fsync`；与 rewrite 共用同一 per-file 互斥锁。
 * @param {string} filePath 目标路径
 * @param {object} record 记录对象
 * @returns {Promise<void>}
 */
export async function appendJsonlSynced(filePath, record) {
	return withAsyncMutex(jsonlMutexKey(filePath), async () => {
		await mkdir(dirname(filePath), { recursive: true })
		const fh = await open(filePath, 'a')
		try {
			await fh.appendFile(`${JSON.stringify(record)}\n`, 'utf8')
			await fh.sync()
		}
		finally {
			await fh.close()
		}
	})
}

/**
 * 写入原子临时文件；若父目录已在 cleanup 竞态中消失（ENOENT）则返回 false。
 * @param {string} temporaryPath 临时文件路径
 * @param {string} data 文件内容
 * @returns {Promise<boolean>} 是否已写入
 */
async function writeAtomicTemporary(temporaryPath, data) {
	try {
		await writeFile(temporaryPath, data, 'utf8')
		return true
	}
	catch (error) {
		if (error?.code === 'ENOENT') return false
		throw error
	}
}

/**
 * 原子写入 JSON 文件（临时文件 + rename）。
 * @param {string} filePath 目标路径
 * @param {object} obj 可 JSON 序列化对象
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(filePath, obj) {
	const dir = dirname(filePath)
	await mkdir(dir, { recursive: true })
	const temporaryPath = atomicTemporaryPath(filePath)
	if (!await writeAtomicTemporary(temporaryPath, JSON.stringify(obj, null, '\t'))) return
	await finalizeAtomicRename(temporaryPath, filePath)
}

/**
 * 原子写入 JSON 并对目标文件 `fsync`。
 * @param {string} filePath 目标路径
 * @param {object} obj 可序列化对象
 * @returns {Promise<void>}
 */
export async function writeJsonAtomicSynced(filePath, obj) {
	const dir = dirname(filePath)
	await mkdir(dir, { recursive: true })
	const temporaryPath = atomicTemporaryPath(filePath)
	if (!await writeAtomicTemporary(temporaryPath, JSON.stringify(obj, null, '\t'))) return
	const fileHandle = await open(temporaryPath, 'r+')
	try {
		await fileHandle.sync()
	}
	finally {
		await fileHandle.close()
	}
	if (!await finalizeAtomicRename(temporaryPath, filePath)) return
	const outFh = await open(filePath, 'r+')
	try {
		await outFh.sync()
	}
	finally {
		await outFh.close()
	}
}
