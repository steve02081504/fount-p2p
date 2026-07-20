/**
 * 子进程 BT 可用性探测：load → poweredOn → stop → exit。
 * 由 `canUseBluetoothRuntime` spawn；勿在父进程直接跑 waitPoweredOn（会拖住事件循环）。
 */
import process from 'node:process'

import { loadNoble, waitPoweredOn } from './runtime.mjs'

const timeoutMs = Number(process.env.FOUNT_BT_PROBE_MS || 3000)

try {
	const noble = await loadNoble()
	if (!noble?.startScanningAsync) process.exit(2)
	await waitPoweredOn(noble, timeoutMs)
	try { noble.stop() } catch { /* Windows 上 stop 偶发崩；子进程反正要退出 */ }
	process.exit(0)
}
catch {
	process.exit(1)
}
