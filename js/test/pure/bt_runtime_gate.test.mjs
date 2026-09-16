import { test } from 'node:test'

import { canUseBluetoothRuntime, probeBluetoothHardware } from '../../discovery/bt/runtime.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('probeBluetoothHardware is boolean or null', () => {
	const hint = probeBluetoothHardware()
	assertEquals(hint === true || hint === false || hint === null, true)
})

test('canUseBluetoothRuntime returns boolean without throwing', async () => {
	const ok = await canUseBluetoothRuntime(500)
	assertEquals(typeof ok, 'boolean')
	// 二次调用走缓存，结果一致
	assertEquals(await canUseBluetoothRuntime(500), ok)
})

test('no adapter hint → canUseBluetoothRuntime is false without needing BT hardware', async () => {
	if (probeBluetoothHardware() !== false) return
	assertEquals(await canUseBluetoothRuntime(500), false)
})
