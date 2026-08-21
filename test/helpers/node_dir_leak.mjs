import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

import { closeNode } from '../../node/instance.mjs'

/**
 * 节点目录句柄泄漏门禁。
 *
 * 所有测试创建的临时目录都应落在 `TEST_ROOT`（专用根目录）下，并在套件末尾由
 * `after` 钩子统一扫描：任何残留目录都会导致测试失败。这比依赖「每个测试自己
 * 记得删干净」的约定更可靠——未来一旦出现文件句柄泄漏（Windows 上会阻止删除），
 * 残留目录必被此门禁捕获并报错，而非被 `rmSync({ force: true })` 静默吞掉。
 */

/** 测试专用临时根目录（避免扫到系统里无关的 fount-* / p2p-*）。 */
export const TEST_ROOT = path.join(os.tmpdir(), `fount-p2p-tests-${process.pid}`)

/** 删除失败时的重试次数 */
const REMOVE_RETRIES = 5
/** 重试间等待毫秒（给异步句柄释放留时间） */
const REMOVE_RETRY_DELAY_MS = 50

/**
 * @param {string} filePath 路径
 * @returns {Promise<boolean>} 是否存在
 */
async function exists(filePath) {
	try {
		await fsp.access(filePath)
		return true
	}
	catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ error.code === 'ENOENT') return false
		throw error
	}
}

/**
 * 解析本进程打开的文件描述符指向的路径（Linux `/proc/self/fd`）。
 * @returns {string[] | null} 非 Linux 平台返回 null（不可枚举）
 */
function listOpenFdTargets() {
	if (process.platform !== 'linux') return null
	try {
		const fdDirectory = '/proc/self/fd'
		return fs.readdirSync(fdDirectory).map(fileDescriptor => {
			try { return fs.readlinkSync(path.join(fdDirectory, fileDescriptor)) } catch { return null }
		}).filter(targetPath => typeof targetPath === 'string')
	}
	catch { return null }
}

/**
 * 统计仍指向 `directory`（或其子项）的打开文件描述符数量。
 * @param {string} directory 目录
 * @returns {number} 泄漏句柄数（非 Linux 平台返回 -1 = 无法枚举）
 */
export function countOpenFdsUnder(directory) {
	const targets = listOpenFdTargets()
	if (targets === null) return -1
	const root = path.resolve(directory)
	return targets.filter(targetPath => {
		const resolvedTarget = path.resolve(targetPath)
		return resolvedTarget === root || resolvedTarget.startsWith(root + path.sep)
	}).length
}

/**
 * 用严格模式删除目录：不传 `force`，失败即抛出并附残留详情，避免
 * Windows 上 open-handle 被 `force` 静默吞掉。带有限重试。
 * @param {string} directory 目录
 * @returns {Promise<void>}
 */
async function removeStrict(directory) {
	/** @type {Error | null} */
	let lastError = null
	for (let attempt = 0; attempt <= REMOVE_RETRIES; attempt++) 
		try {
			await fsp.rm(directory, { recursive: true })
			return
		}
		catch (error) {
			// 目录已不存在即视为成功（幂等 teardown）。
			if (/** @type {NodeJS.ErrnoException} */ error.code === 'ENOENT') return
			lastError = /** @type {Error} */error
			if (attempt === REMOVE_RETRIES) break
			await new Promise(resolve => setTimeout(resolve, REMOVE_RETRY_DELAY_MS))
		}
	
	const remainingPaths = await collectRemaining(directory)
	throw new Error(
		`removeNodeDirStrict: 目录未能删除：${directory}\n` +
		`cause: ${lastError?.message}\n` +
		`remaining: ${remainingPaths.length ? remainingPaths.join('\n  ') : '(无法枚举残留)'}\n` +
		'hint: 大概率有未关闭的文件句柄（Windows 上 open-handle 会阻止删除）'
	)
}

/**
 * @param {string} directory 目录
 * @returns {Promise<string[]>} 残留子路径
 */
async function collectRemaining(directory) {
	/** @type {string[]} */
	const remainingPaths = []
	/**
	 *
	 * @param current
	 */
	/** @param {string} current 当前目录路径 */
	async function walk(current) {
		let entries
		try { entries = await fsp.readdir(current, { withFileTypes: true }) }
		catch { return }
		for (const entry of entries) {
			const entryPath = path.join(current, entry.name)
			if (entry.isDirectory()) await walk(entryPath)
			else remainingPaths.push(entryPath)
		}
		if (!remainingPaths.some(subPath => subPath.startsWith(current + path.sep))) remainingPaths.push(current)
	}
	await walk(directory)
	return remainingPaths
}

/**
 * 创建测试临时目录（落在专用根目录下）。
 * @param {string} prefix 前缀
 * @returns {Promise<string>} 目录绝对路径
 */
export async function mkTestNodeDir(prefix) {
	await fsp.mkdir(TEST_ROOT, { recursive: true })
	return fsp.mkdtemp(path.join(TEST_ROOT, prefix))
}

/**
 * 创建测试临时目录（同步版）。
 * @param {string} prefix 前缀
 * @returns {string} 目录绝对路径
 */
export function mkTestNodeDirSync(prefix) {
	fs.mkdirSync(TEST_ROOT, { recursive: true })
	return fs.mkdtempSync(path.join(TEST_ROOT, prefix))
}

/**
 * 清理测试目录并断言无泄漏：
 * 1. 统计并断言没有指向该目录的打开文件描述符（Linux；跨平台 + 严格删除兜底）；
 * 2. 严格删除（不吞错误，Windows 上 open-handle 会因此失败）；
 * 3. 断言目录已彻底消失。
 * @param {string} directory 目录
 * @returns {Promise<void>}
 */
export async function assertCleanlyRemoved(directory) {
	const leakedFds = countOpenFdsUnder(directory)
	if (leakedFds > 0)
		throw new Error(`assertCleanlyRemoved: 有 ${leakedFds} 个打开的文件句柄仍指向 ${directory} —— 文件流/句柄泄漏`)
	await removeStrict(directory)
	if (await exists(directory))
		throw new Error(`assertCleanlyRemoved: 目录删除后仍存在：${directory}`)
}

/**
 * 关闭节点并严格删除其目录（节点测试 teardown 的统一入口）。
 * @param {string} directory 目录
 * @returns {Promise<void>}
 */
export async function teardownTestNodeDir(directory) {
	await closeNode()
	await assertCleanlyRemoved(directory)
}

/**
 * 套件末尾泄漏门禁：扫描专用根目录，任何残留（未删/删不掉的）目录都触发失败。
 * 该钩子在模块加载时注册，凡导入本 helper 的测试文件自动获得此门禁。
 */
after(async () => {
	await fsp.mkdir(TEST_ROOT, { recursive: true })
	const leftovers = []
	let entries
	try { entries = await fsp.readdir(TEST_ROOT, { withFileTypes: true }) } catch { return }
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const fullPath = path.join(TEST_ROOT, entry.name)
		const leakedFds = countOpenFdsUnder(fullPath)
		try { await removeStrict(fullPath) } catch { leftovers.push(fullPath) }
		if (leakedFds > 0)
			leftovers.push(`${fullPath} (${leakedFds} 打开句柄)`)
	}
	if (leftovers.length)
		throw new Error(
			`测试泄漏门禁失败：专用根目录 ${TEST_ROOT} 下仍有 ${leftovers.length} 个残留（句柄泄漏或未清理）：\n` +
			leftovers.join('\n  ')
		)
})
