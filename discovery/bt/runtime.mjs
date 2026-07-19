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
 * 加载 Noble BLE central。
 * @returns {Promise<any>} noble 运行时
 */
export async function loadNoble() {
	const mod = await import('@stoprocent/noble')
	if (typeof mod.withBindings === 'function') return mod.withBindings('default')
	return mod.default ?? mod
}

/**
 * 加载 Bleno BLE peripheral。
 * @returns {Promise<any>} bleno 运行时
 */
export async function loadBleno() {
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
	if (typeof wait !== 'function')
		throw new Error('p2p: bluetooth runtime missing waitForPoweredOn(Async)')
	return wait.call(runtime, timeout)
}
