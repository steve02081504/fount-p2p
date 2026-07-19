import { Buffer } from 'node:buffer'

import { getBtPeerHint } from './peer_hints.mjs'
import { loadBleno, loadNoble, resolveBtRole, waitPoweredOn } from './runtime.mjs'

/** 重导出 waitPoweredOn，供 discovery 调用方使用。 */
export { waitPoweredOn } from './runtime.mjs'

const BT_SERVICE_UUID = 'f017f017f017f017f017f017f017f017'
const BT_CHARACTERISTIC_UUID = 'f017f017f017f017f017f017f017f018'
const BT_SIGNAL_CHAR_UUID = 'f017f017f017f017f017f017f017f01b'
const BT_DEVICE_NAME = 'fount-bt'
const MAX_ADVERT_BLOB_BYTES = 12 * 1024
const MAX_SIGNAL_BLOB_BYTES = 8 * 1024
const PERIPHERAL_RESCAN_MS = 15_000

/**
 * 探测本机 noble 运行时是否具备 BT 扫描所需 API。
 * @returns {Promise<boolean>} noble 可加载且具备 startScanningAsync 与 waitForPoweredOn(Async) 时为 true
 */
export async function canUseBluetoothDiscovery() {
	try {
		const noble = await loadNoble()
		if (typeof noble.startScanningAsync !== 'function') return false
		const wait = noble.waitForPoweredOnAsync ?? noble.waitForPoweredOn
		return typeof wait === 'function'
	}
	catch {
		return false
	}
}

/**
 * 将 advert 映射序列化为可读 characteristic blob。
 * @param {Map<string, Uint8Array>} adverts topic → payload 映射
 * @returns {Buffer} JSON 序列化后的 advert blob
 */
function serializeAdvertBlob(adverts) {
	const entries = [...adverts.entries()].map(([topic, bytes]) => ({
		topic,
		data: Buffer.from(bytes).toString('base64'),
	}))
	const blob = Buffer.from(JSON.stringify({ entries }), 'utf8')
	if (blob.byteLength > MAX_ADVERT_BLOB_BYTES)
		throw new Error(`p2p: bluetooth advert blob exceeds ${MAX_ADVERT_BLOB_BYTES} bytes`)
	return blob
}

/**
 * 从 characteristic blob 解析 advert 列表。
 * @param {Uint8Array | Buffer} raw 原始 blob 字节
 * @returns {Array<{ topic: string, bytes: Uint8Array }>} 解析出的 advert 条目
 */
function parseAdvertBlob(raw) {
	try {
		const parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
		if (!Array.isArray(parsed?.entries)) return []
		return parsed.entries.map(entry => ({
			topic: String(entry?.topic || ''),
			bytes: Uint8Array.from(Buffer.from(String(entry?.data || ''), 'base64')),
		})).filter(entry => entry.topic && entry.bytes.byteLength)
	}
	catch {
		return []
	}
}

/**
 * 向 topic bucket 注册监听器。
 * @param {Map<string, Set<Function>>} bucket topic → 监听器集合
 * @param {string} topic 订阅 topic
 * @param {Function} listener advert 回调
 * @returns {() => void} 取消订阅函数
 */
function addListener(bucket, topic, listener) {
	if (!bucket.has(topic)) bucket.set(topic, new Set())
	bucket.get(topic).add(listener)
	return () => {
		const set = bucket.get(topic)
		if (!set) return
		set.delete(listener)
		if (!set.size) bucket.delete(topic)
	}
}

/**
 * 蓝牙发现提供者：
 * - 默认在 Windows 上只启用 scan 侧发现（单适配器 central+peripheral 常冲突）
 * - 其他平台默认 dual：advertise + scan
 * - 通过固定 BLE service + read characteristic 传输完整 advert 列表，避免 31-byte 广告包限制
 * - dual 下额外暴露 write characteristic 传短信令；central 可按 peer hint 写信令
 *
 * @returns {import('./index.mjs').DiscoveryProvider} Bluetooth 发现提供者
 */
export function createBluetoothDiscoveryProvider() {
	const role = resolveBtRole()
	/** @type {Map<string, Uint8Array>} */
	const adverts = new Map()
	/** @type {Map<string, Set<Function>>} */
	const advertListeners = new Map()
	/** @type {Map<string, Set<Function>>} */
	const signalListeners = new Map()
	/** @type {Map<string, number>} */
	const inspectedAt = new Map()
	let nobleRuntime = null
	let blenoRuntime = null
	let scanningStarted = false
	let advertisingStarted = false

	/**
	 * 初始化 peripheral（Bleno）运行时。
	 * @returns {Promise<any|null>} Bleno 实例；scan 模式下为 null
	 */
	async function ensurePeripheralRuntime() {
		if (role === 'scan') return null
		if (blenoRuntime) return blenoRuntime
		const bleno = await loadBleno()
		const advertCharacteristic = new bleno.Characteristic({
			uuid: BT_CHARACTERISTIC_UUID,
			properties: ['read'],
			/**
			 * stoprocent/bleno onReadRequest(connection, offset, callback)
			 * @param {*} _connection 连接句柄
			 * @param {number} offset 偏移
			 * @param {Function} callback 结果
			 * @returns {void}
			 */
			onReadRequest(_connection, offset, callback) {
				try {
					const blob = serializeAdvertBlob(adverts)
					if (offset > blob.length) {
						callback(bleno.Characteristic.RESULT_INVALID_OFFSET)
						return
					}
					callback(bleno.Characteristic.RESULT_SUCCESS, blob.subarray(offset))
				}
				catch {
					callback(bleno.Characteristic.RESULT_UNLIKELY_ERROR)
				}
			},
		})
		const signalCharacteristic = new bleno.Characteristic({
			uuid: BT_SIGNAL_CHAR_UUID,
			properties: ['write', 'writeWithoutResponse'],
			/**
			 * stoprocent/bleno onWriteRequest(connection, data, offset, withoutResponse, callback)
			 * @param {*} _connection 连接句柄
			 * @param {Buffer} data 信令 blob
			 * @param {number} _offset 偏移
			 * @param {boolean} _withoutResponse 无响应写
			 * @param {Function} callback 结果
			 * @returns {void}
			 */
			onWriteRequest(_connection, data, _offset, _withoutResponse, callback) {
				try {
					const parsed = JSON.parse(Buffer.from(data).toString('utf8'))
					const topic = String(parsed?.topic || '')
					const bytes = Uint8Array.from(Buffer.from(String(parsed?.data || ''), 'base64'))
					if (topic && bytes.byteLength) 
						for (const listener of signalListeners.get(topic) || [])
							listener(bytes, { provider: 'bt' })
					
					callback(bleno.Characteristic.RESULT_SUCCESS)
				}
				catch {
					callback(bleno.Characteristic.RESULT_UNLIKELY_ERROR)
				}
			},
		})
		await waitPoweredOn(bleno, 5_000)
		await bleno.setServicesAsync([
			new bleno.PrimaryService({
				uuid: BT_SERVICE_UUID,
				characteristics: [advertCharacteristic, signalCharacteristic],
			}),
		])
		blenoRuntime = bleno
		return bleno
	}

	/**
	 * 刷新 BLE 广播状态。
	 * @returns {Promise<void>}
	 */
	async function refreshAdvertising() {
		if (role === 'scan') return
		const bleno = await ensurePeripheralRuntime()
		if (!bleno) return
		if (!adverts.size && !signalListeners.size) {
			if (advertisingStarted) {
				await bleno.stopAdvertisingAsync().catch(() => { })
				advertisingStarted = false
			}
			return
		}
		if (adverts.size) serializeAdvertBlob(adverts)
		if (!advertisingStarted) {
			await bleno.startAdvertisingAsync(BT_DEVICE_NAME, [BT_SERVICE_UUID])
			advertisingStarted = true
		}
	}

	/**
	 * 连接并读取远端 peripheral 的 advert characteristic。
	 * @param {*} peripheral Noble peripheral 对象
	 * @returns {Promise<void>}
	 */
	async function inspectPeripheral(peripheral) {
		const inspectKey = String(peripheral?.id || peripheral?.address || '')
		if (!inspectKey) return
		const lastSeenAt = inspectedAt.get(inspectKey) || 0
		if (Date.now() - lastSeenAt < PERIPHERAL_RESCAN_MS) return
		inspectedAt.set(inspectKey, Date.now())
		try {
			await peripheral.connectAsync()
			const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
				[BT_SERVICE_UUID],
				[BT_CHARACTERISTIC_UUID],
			)
			if (!characteristics?.length) return
			const raw = await characteristics[0].readAsync()
			for (const { topic, bytes } of parseAdvertBlob(raw)) {
				const listeners = advertListeners.get(topic)
				if (!listeners?.size) continue
				for (const listener of listeners)
					listener(bytes, { provider: 'bt', peripheralId: inspectKey })
			}
		}
		catch {
			/* ignore transient bluetooth failures */
		}
		finally {
			try { await peripheral.disconnectAsync() } catch { /* ignore */ }
		}
	}

	/**
	 * 启动 Noble 扫描运行时。
	 * @returns {Promise<void>}
	 */
	async function ensureScanRuntime() {
		if (scanningStarted) return
		const noble = await loadNoble()
		await waitPoweredOn(noble, 5_000)
		noble.on('discover', peripheral => {
			void inspectPeripheral(peripheral).catch(() => { })
		})
		await noble.startScanningAsync([BT_SERVICE_UUID], true)
		nobleRuntime = noble
		scanningStarted = true
	}

	/**
	 * Central：按 peer hint 连接并对端 signal characteristic 写短包。
	 * 无 hint 时返回 false（正常降级，不算错误）。
	 * @param {string} topic 信令 topic
	 * @param {string} to 目标 nodeHash
	 * @param {Uint8Array} bytes 载荷
	 * @returns {Promise<boolean>} 是否投递
	 */
	async function sendSignalViaGatt(topic, to, bytes) {
		const hint = getBtPeerHint(to)
		if (!hint) return false
		const blob = Buffer.from(JSON.stringify({
			topic: String(topic),
			to: String(to),
			data: Buffer.from(bytes).toString('base64'),
		}), 'utf8')
		if (blob.byteLength > MAX_SIGNAL_BLOB_BYTES)
			throw new Error(`p2p: bt signal blob exceeds ${MAX_SIGNAL_BLOB_BYTES} bytes`)
		await ensureScanRuntime()
		const noble = nobleRuntime
		const wantId = hint.peripheralId
		/**
		 * 先查 noble 已缓存的 peripheral，避免只等下一次 advertise 漏报。
		 * @returns {*|null} 已缓存的 peripheral，未命中为 null
		 */
		function cachedPeripheral() {
			const table = noble?._peripherals
			if (!table || typeof table !== 'object') return null
			for (const found of Object.values(table)) {
				const id = String(found?.id || found?.address || '')
				if (id === wantId) return found
			}
			return null
		}
		const peripheral = cachedPeripheral() ?? await new Promise((resolve, reject) => {
			const deadline = setTimeout(() => {
				cleanup()
				reject(new Error('p2p: bt signal peripheral timeout'))
			}, 8_000)
			/**
			 * @returns {void}
			 */
			function cleanup() {
				clearTimeout(deadline)
				noble.removeListener('discover', onDiscover)
			}
			/**
			 * @param {*} found peripheral
			 * @returns {void}
			 */
			function onDiscover(found) {
				const id = String(found?.id || found?.address || '')
				if (id !== wantId) return
				cleanup()
				resolve(found)
			}
			noble.on('discover', onDiscover)
			const again = cachedPeripheral()
			if (again) {
				cleanup()
				resolve(again)
			}
		})
		try {
			await peripheral.connectAsync()
			const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
				[BT_SERVICE_UUID],
				[BT_SIGNAL_CHAR_UUID],
			)
			if (!characteristics?.length) throw new Error('p2p: bt signal characteristic missing')
			await characteristics[0].writeAsync(blob, false)
		}
		finally {
			try { await peripheral.disconnectAsync() } catch { /* ignore */ }
		}
		return true
	}

	return {
		id: 'bt',
		priority: 20,
		caps: { canDiscover: true, canSignal: true, canRelay: false },
		/**
		 * 广播指定 topic 的 advert。
		 * @param {string} topic advert 主题
		 * @param {Uint8Array} bytes advert 载荷
		 * @returns {Promise<() => void>} 取消广播函数
		 */
		async advertise(topic, bytes) {
			if (role === 'scan') return () => { }
			adverts.set(String(topic), Uint8Array.from(bytes))
			await refreshAdvertising()
			return () => {
				adverts.delete(String(topic))
				void refreshAdvertising().catch(() => { })
			}
		},
		/**
		 * 订阅指定 topic 的远端 advert。
		 * @param {string} topic advert 主题
		 * @param {Function} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消订阅函数
		 */
		async subscribe(topic, onAdvert) {
			await ensureScanRuntime()
			return addListener(advertListeners, String(topic), onAdvert)
		},
		/**
		 * 经 GATT 向近场 peer 发送信令；无 peer hint 时返回 false。
		 * @param {string} topic 信令 topic
		 * @param {string} to 目标 nodeHash
		 * @param {Uint8Array} bytes 载荷
		 * @returns {Promise<boolean>} 是否投递
		 */
		sendSignal(topic, to, bytes) {
			return sendSignalViaGatt(topic, to, bytes)
		},
		/**
		 * 监听经本机 peripheral signal characteristic 写入的信令。
		 * @param {string} topic 信令 topic
		 * @param {Function} onSignal 回调
		 * @returns {Promise<() => void>} 取消订阅
		 */
		async onSignal(topic, onSignal) {
			if (role === 'scan') return () => { }
			await ensurePeripheralRuntime()
			await refreshAdvertising()
			const stop = addListener(signalListeners, String(topic), onSignal)
			return () => {
				stop()
				void refreshAdvertising().catch(() => { })
			}
		},
	}
}
