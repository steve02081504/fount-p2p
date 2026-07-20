import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

/**
 * 解析 Bluetooth 角色（scan / dual）。
 * Win32 默认 scan（单适配器 central+peripheral 常冲突）；可用 FOUNT_BT_DISCOVERY_ROLE 覆盖。
 * @returns {'scan' | 'dual'} 生效角色
 */
export function resolveBtRole() {
	const override = String(process.env.FOUNT_BT_DISCOVERY_ROLE || '').trim().toLowerCase()
	if (override === 'dual') return 'dual'
	if (override === 'scan') return 'scan'
	return process.platform === 'win32' ? 'scan' : 'dual'
}

/**
 * 廉价硬件探测：明确无适配器时跳过 noble/bleno import（加载本身会拉起 native，无适配器时常在 teardown SIGSEGV）。
 * @returns {boolean | null} true=有迹象，false=明确无，null=未知（继续尝试加载，失败则回落）
 */
export function probeBluetoothHardware() {
	if (process.platform === 'linux') try {
		const dir = '/sys/class/bluetooth'
		if (!existsSync(dir)) return false
		return readdirSync(dir).some(name => name && !name.startsWith('.'))
	}
	catch {
		return false
	}
	return null
}

/** @type {boolean | null} canUseBluetoothRuntime 缓存 */
let cachedRuntimeOk = null
/** @type {Promise<boolean> | null} 并发 canUse 合并为一次子进程探测 */
let probeInflight = null

const PROBE_CHILD = join(dirname(fileURLToPath(import.meta.url)), 'probe_child.mjs')

/**
 * 在子进程中探测 BT（父进程 waitPoweredOn 会拖住事件循环；stop() 还可能 AV）。
 * @param {number} timeoutMs waitPoweredOn 超时
 * @returns {Promise<boolean>} 子进程 exit 0 为可用
 */
function probeBluetoothInSubprocess(timeoutMs) {
	return new Promise(resolve => {
		const child = spawn(process.execPath, [PROBE_CHILD], {
			stdio: 'ignore',
			env: {
				...process.env,
				FOUNT_BT_PROBE_MS: String(timeoutMs),
			},
			windowsHide: true,
		})
		// 探测是旁路缓存填充；勿拖住父进程事件循环 / shutdown 退出。
		child.unref()
		let settled = false
		/**
		 * @param {boolean} ok 探测结果
		 * @returns {void}
		 */
		const finish = ok => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(ok)
		}
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			finish(false)
		}, timeoutMs + 5_000)
		timer.unref()
		child.once('error', () => finish(false))
		child.once('exit', (code, signal) => {
			if (signal) finish(false)
			else finish(code === 0)
		})
	})
}

/**
 * 探测 BT 栈是否真正可用（硬件迹象 → 子进程 load → poweredOn）。
 * 任一步失败返回 false；不抛错。
 * @param {number} [timeoutMs=3000] waitPoweredOn 超时
 * @returns {Promise<boolean>} 可用为 true
 */
export async function canUseBluetoothRuntime(timeoutMs = 3000) {
	if (cachedRuntimeOk !== null) return cachedRuntimeOk
	if (probeBluetoothHardware() === false) {
		cachedRuntimeOk = false
		return false
	}
	if (!probeInflight) {
		probeInflight = probeBluetoothInSubprocess(timeoutMs)
			.then(ok => {
				cachedRuntimeOk = ok
				return ok
			})
			.finally(() => { probeInflight = null })
	}
	return probeInflight
}

/**
 * 加载 Noble BLE central。明确无适配器时直接抛错，避免无意义的 native import。
 * @returns {Promise<any>} noble 运行时
 */
export async function loadNoble() {
	if (probeBluetoothHardware() === false)
		throw new Error('p2p: no bluetooth adapter')
	const mod = await import('@stoprocent/noble')
	return mod?.withBindings?.('default') || mod?.default || mod
}

/**
 * 加载 Bleno BLE peripheral。明确无适配器时直接抛错，避免无意义的 native import。
 * @returns {Promise<any>} bleno 运行时
 */
export async function loadBleno() {
	if (probeBluetoothHardware() === false)
		throw new Error('p2p: no bluetooth adapter')
	const mod = await import('@stoprocent/bleno')
	if (typeof mod.withBindings === 'function') return mod.withBindings('default')
	return mod.default ?? mod
}

/**
 * 等待 BLE 运行时 poweredOn（兼容 noble/bleno v1/v2）。
 * @param {*} runtime noble 或 bleno
 * @param {number} [timeout] 超时毫秒
 * @returns {Promise<void>}
 */
export async function waitPoweredOn(runtime, timeout) {
	const wait = runtime.waitForPoweredOnAsync ?? runtime.waitForPoweredOn
	if (!wait)
		throw new Error('p2p: bluetooth runtime missing waitForPoweredOn(Async)')
	return wait.call(runtime, timeout)
}
