import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

import { normalizeHex64 } from '../../core/hexIds.mjs'
import { getBtPeerHint } from '../../discovery/bt/peer_hints.mjs'
import { canUseBluetoothRuntime, loadBleno, loadNoble, resolveBtRole, waitPoweredOn } from '../../discovery/bt/runtime.mjs'
import { asLinkHandle, coercePipeInbound, createLinkPipe } from '../pipe.mjs'

import { LINK_LEVEL_BLE_GATT } from './levels.mjs'

/** BLE GATT 数据 service UUID。 */
export const BLE_DATA_SERVICE_UUID = 'f017f017f017f017f017f017f017f019'
/** BLE GATT 数据 characteristic UUID。 */
export const BLE_DATA_CHAR_UUID = 'f017f017f017f017f017f017f017f01a'
const BT_DEVICE_NAME = 'fount-bt'

/**
 * 探测 BLE GATT 数据链路是否可用；失败则回落其它 link provider。
 * @returns {Promise<boolean>} 可用为 true
 */
export async function canUseBleGattLink() {
	return canUseBluetoothRuntime()
}

/**
 * 在 GATT write/notify 上建立 pipe。
 * @param {object} options 配置
 * @returns {Promise<import('./index.mjs').LinkHandle>} 已启动握手的 link
 */
async function openGattPipe(options) {
	const linkId = normalizeHex64(options.linkId)
	if (!linkId) throw new Error('p2p: ble_gatt linkId required')

	const pipe = createLinkPipe({
		providerId: 'ble_gatt',
		level: LINK_LEVEL_BLE_GATT,
		initiator: !!options.initiator,
		nodeHash: options.nodeHash,
		localIdentity: options.localIdentity,
		/** @returns {string} 本端 binding（linkId） */
		getLocalBinding: () => linkId,
		/** @returns {string} 对端 binding（linkId） */
		getRemoteBinding: () => linkId,
		/**
		 * @param {string} text control JSON
		 * @returns {Promise<void>}
		 */
		async sendControlText(text) {
			await Promise.resolve(options.write(Buffer.from(text, 'utf8')))
		},
		/**
		 * @param {string} _action action
		 * @param {Uint8Array} frame 帧
		 * @returns {Promise<void>}
		 */
		async sendFrame(_action, frame) {
			await Promise.resolve(options.write(Buffer.from(frame)))
		},
		closeTransport: options.closeTransport,
	})

	const stopNotify = options.onNotify(data => {
		pipe.handleInbound(coercePipeInbound(data))
	})
	pipe.onDown(() => {
		try { stopNotify() } catch { /* ignore */ }
	})

	if (options.initiator)
		await Promise.resolve(options.write(Buffer.from(JSON.stringify({
			type: 'link-open',
			linkId,
			from: options.localIdentity?.nodeHash || '',
		}), 'utf8')))

	await pipe.startHandshake()
	return asLinkHandle(pipe)
}

/**
 * Central dial。
 * @param {object} options dial 选项
 * @returns {Promise<import('./index.mjs').LinkHandle>} 已就绪的 link
 */
async function dialBleGatt(options) {
	const remoteNodeHash = normalizeHex64(options.nodeHash)
	const hint = getBtPeerHint(remoteNodeHash)
	if (!hint) throw new Error('p2p: ble_gatt no peer hint')
	const noble = await loadNoble()
	await waitPoweredOn(noble, 5_000)

	const peripheral = await new Promise((resolve, reject) => {
		const deadline = setTimeout(() => {
			cleanup()
			reject(new Error('p2p: ble_gatt peripheral scan timeout'))
		}, 8_000)
		/**
		 * @returns {void}
		 */
		function cleanup() {
			clearTimeout(deadline)
			noble.removeListener('discover', onDiscover)
			void noble.stopScanningAsync?.().catch(() => { })
		}
		/**
		 * @param {*} found peripheral
		 * @returns {void}
		 */
		function onDiscover(found) {
			const id = String(found?.id || found?.address || '')
			if (id !== hint.peripheralId) return
			cleanup()
			resolve(found)
		}
		noble.on('discover', onDiscover)
		void noble.startScanningAsync([BLE_DATA_SERVICE_UUID], true).catch(reject)
	})

	await peripheral.connectAsync()
	const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
		[BLE_DATA_SERVICE_UUID],
		[BLE_DATA_CHAR_UUID],
	)
	const characteristic = characteristics?.[0]
	if (!characteristic) {
		try { await peripheral.disconnectAsync() } catch { /* ignore */ }
		throw new Error('p2p: ble_gatt data characteristic missing')
	}

	const linkId = randomBytes(32).toString('hex')
	/** @type {Set<(data: Buffer) => void>} */
	const notifyHandlers = new Set()
	characteristic.on('data', data => {
		if (data == null) return
		for (const handler of notifyHandlers)
			handler(Buffer.from(data))
	})
	await characteristic.subscribeAsync()

	const link = await openGattPipe({
		initiator: true,
		linkId,
		nodeHash: remoteNodeHash,
		localIdentity: options.localIdentity,
		/**
		 * @param {Buffer} data 出站
		 * @returns {Promise<void>}
		 */
		async write(data) {
			await characteristic.writeAsync(data, false)
		},
		/**
		 * @param {(data: Buffer) => void} handler notify 回调
		 * @returns {() => void} 取消订阅
		 */
		onNotify(handler) {
			notifyHandlers.add(handler)
			return () => notifyHandlers.delete(handler)
		},
		/**
		 * @returns {Promise<void>}
		 */
		async closeTransport() {
			try { await characteristic.unsubscribeAsync() } catch { /* ignore */ }
			try { await peripheral.disconnectAsync() } catch { /* ignore */ }
		},
	})
	await link.ready
	return link
}

/**
 * 创建 ble_gatt LinkProvider。
 * 每个实例独立；注册 id 唯一，避免同进程多 registry 互相覆盖 onInbound/localIdentity。
 * 链路上的 `providerId` 仍为 `ble_gatt`。
 * 注意：本机只有一块 BLE 适配器时，多实例仍会争用同一 bleno peripheral（生产应一进程一节点）。
 * @returns {import('./index.mjs').LinkProvider & { ensureListening?: Function }} BLE GATT provider
 */
export function createBleGattLinkProvider() {
	const instanceId = `ble_gatt:${randomBytes(4).toString('hex')}`
	const role = resolveBtRole()
	/** @type {((link: import('./index.mjs').LinkHandle) => void) | null} */
	let onInbound = null
	/** @type {object | null} */
	let localIdentity = null
	/** @type {any} */
	let blenoRuntime = null
	/** @type {any} */
	let dataCharacteristic = null
	let listening = false
	/** @type {import('./index.mjs').LinkHandle | null} */
	let activeInbound = null
	/** @type {((data: Buffer) => void) | null} */
	let sessionInbound = null
	let acceptInflight = false

	/**
	 * @returns {Promise<void>}
	 */
	async function ensurePeripheral() {
		if (role === 'scan' || listening) return
		const bleno = await loadBleno()
		const characteristic = new bleno.Characteristic({
			uuid: BLE_DATA_CHAR_UUID,
			properties: ['write', 'writeWithoutResponse', 'notify'],
			/**
			 * stoprocent/bleno onWriteRequest(connection, data, offset, withoutResponse, callback)
			 * @param {*} _connection 连接句柄
			 * @param {Buffer} data 写入
			 * @param {number} _offset 偏移
			 * @param {boolean} _withoutResponse 无响应写
			 * @param {Function} callback 结果
			 * @returns {void}
			 */
			onWriteRequest(_connection, data, _offset, _withoutResponse, callback) {
				const buf = Buffer.from(data)
				if (sessionInbound) sessionInbound(buf)
				else void acceptPeripheralWrite(buf).catch(() => { })
				callback(bleno.Characteristic.RESULT_SUCCESS)
			},
		})

		await waitPoweredOn(bleno, 5_000)
		await bleno.setServicesAsync([
			new bleno.PrimaryService({
				uuid: BLE_DATA_SERVICE_UUID,
				characteristics: [characteristic],
			}),
		])
		await bleno.startAdvertisingAsync(BT_DEVICE_NAME, [BLE_DATA_SERVICE_UUID])
		blenoRuntime = bleno
		dataCharacteristic = characteristic
		listening = true
	}

	/**
	 * @param {Buffer} buf 入站写（首包应为 link-open）
	 * @returns {Promise<void>}
	 */
	async function acceptPeripheralWrite(buf) {
		if (activeInbound || acceptInflight || !onInbound || !localIdentity) return
		let parsed
		try {
			parsed = JSON.parse(Buffer.from(buf).toString('utf8'))
		}
		catch {
			return
		}
		if (parsed?.type !== 'link-open' || !parsed.linkId) return
		acceptInflight = true
		try {
			const link = await openGattPipe({
				initiator: false,
				linkId: parsed.linkId,
				nodeHash: normalizeHex64(parsed.from) || null,
				localIdentity,
				/**
				 * @param {Buffer} data 出站
				 * @returns {void}
				 */
				write(data) {
					dataCharacteristic?.notify(data)
				},
				/**
				 * @param {(data: Buffer) => void} handler pipe 入站
				 * @returns {() => void} 取消订阅
				 */
				onNotify(handler) {
					sessionInbound = handler
					return () => { sessionInbound = null }
				},
				/**
				 * @returns {void}
				 */
				closeTransport() {
					activeInbound = null
					sessionInbound = null
					acceptInflight = false
				},
			})
			activeInbound = link
			onInbound(link)
		}
		catch {
			sessionInbound = null
			acceptInflight = false
		}
	}

	return {
		id: instanceId,
		level: LINK_LEVEL_BLE_GATT,
		caps: { needsOfferAnswer: false, needsDiscoverySignal: false },
		isAvailable: canUseBleGattLink,
		/**
		 * @param {{ nodeHash: string }} remote 远端
		 * @returns {boolean} 是否有 BT peer hint
		 */
		canReach(remote) {
			return !!getBtPeerHint(remote.nodeHash)
		},
		/**
		 * @param {object} options dial 选项
		 * @returns {Promise<import('./index.mjs').LinkHandle>} 已就绪的 link
		 */
		async dial(options) {
			return dialBleGatt(options)
		},
		/**
		 * @param {{ onInbound: (link: import('./index.mjs').LinkHandle) => void, localIdentity: object }} handlers 回调
		 * @returns {Promise<() => void>} 停止 listening
		 */
		async ensureListening(handlers) {
			onInbound = handlers.onInbound
			localIdentity = handlers.localIdentity
			if (role === 'scan') return () => { onInbound = null }
			await ensurePeripheral()
			return () => {
				onInbound = null
				if (blenoRuntime) {
					void blenoRuntime.stopAdvertisingAsync?.().catch(() => { })
					listening = false
					dataCharacteristic = null
				}
			}
		},
	}
}
