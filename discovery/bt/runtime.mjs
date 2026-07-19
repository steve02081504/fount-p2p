import { existsSync, readdirSync } from 'node:fs'
import process from 'node:process'

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

/**
 * 探测 BT 栈是否真正可用（有适配器迹象 → 能 load → poweredOn）。
 * 任一步失败返回 false，调用方回落其它 discovery/link；不抛错。
 * @param {number} [timeoutMs=3000] waitPoweredOn 超时
 * @returns {Promise<boolean>} 可用为 true
 */
export async function canUseBluetoothRuntime(timeoutMs = 3000) {
	if (cachedRuntimeOk !== null) return cachedRuntimeOk
	if (probeBluetoothHardware() === false) {
		cachedRuntimeOk = false
		return false
	}
	try {
		const noble = await loadNoble()
		if (!noble.startScanningAsync) {
			cachedRuntimeOk = false
			return false
		}
		await waitPoweredOn(noble, timeoutMs)
		cachedRuntimeOk = true
	}
	catch {
		cachedRuntimeOk = false
	}
	return cachedRuntimeOk
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
