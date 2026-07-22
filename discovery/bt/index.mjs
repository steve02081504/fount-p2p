import { Buffer } from 'node:buffer'

import { isHex64, normalizeHex64 } from '../../core/hexIds.mjs'
import { nodeDebug, shortHash } from '../../node/log.mjs'
import { noteAdvertPeerHints } from '../advert_peer_hints.mjs'
import { ingestNetworkAdvert } from '../adverts.mjs'

import { getBtPeerHint } from './peer_hints.mjs'
import { canUseBluetoothRuntime, loadBleno, loadNoble, resolveBtRole, waitPoweredOn } from './runtime.mjs'

/** 重导出 waitPoweredOn，供 discovery 调用方使用。 */
export { waitPoweredOn } from './runtime.mjs'

const BT_SERVICE_UUID = 'f017f017f017f017f017f017f017f017'
const BT_CHARACTERISTIC_UUID = 'f017f017f017f017f017f017f017f018'
const BT_SIGNAL_CHAR_UUID = 'f017f017f017f017f017f017f017f01b'
const BT_DEVICE_NAME = 'fount-bt'
const MAX_PRESENCE_BLOB_BYTES = 12 * 1024
const MAX_SIGNAL_BLOB_BYTES = 8 * 1024
const PERIPHERAL_RESCAN_MS = 15_000

/** @type {Map<string, number>} nodeHash → lastSeenAt */
const visibleByHash = new Map()

/**
 * @param {string} nodeHash 节点 hash
 * @param {number} [now=Date.now()] 当前时间
 * @returns {void}
 */
export function noteBtVisibleNode(nodeHash, now = Date.now()) {
	const hash = normalizeHex64(nodeHash)
	if (!isHex64(hash)) return
	visibleByHash.set(hash, now)
}

/**
 * @param {number} [now=Date.now()] 当前时间
 * @param {number} [ttlMs=PERIPHERAL_RESCAN_MS * 4] TTL
 * @returns {string[]} 可见 nodeHash
 */
export function listBtVisibleNodeHashes(now = Date.now(), ttlMs = PERIPHERAL_RESCAN_MS * 4) {
	/** @type {string[]} */
	const out = []
	for (const [hash, seenAt] of visibleByHash)
		if (now - seenAt <= ttlMs) out.push(hash)
		else visibleByHash.delete(hash)
	return out
}

/** @returns {void} 测试用 */
export function clearBtVisibleNodes() {
	visibleByHash.clear()
}

/**
 * @returns {Promise<boolean>} 可用为 true
 */
export async function canUseBluetoothDiscovery() {
	return canUseBluetoothRuntime()
}

/**
 * @param {Map<string, Uint8Array>} presence nodeHash → encrypted advert
 * @returns {Buffer} JSON blob
 */
function serializePresenceBlob(presence) {
	const entries = [...presence.entries()].map(([nodeHash, bytes]) => ({
		nodeHash,
		data: Buffer.from(bytes).toString('base64'),
	}))
	const blob = Buffer.from(JSON.stringify({ entries }), 'utf8')
	if (blob.byteLength > MAX_PRESENCE_BLOB_BYTES)
		throw new Error(`p2p: bluetooth presence blob exceeds ${MAX_PRESENCE_BLOB_BYTES} bytes`)
	return blob
}

/**
 * 外层 JSON 的 nodeHash 不可信；只抽出加密 advert bytes，验签后再记可见池 / hint。
 * @param {Uint8Array | Buffer} raw 原始 blob
 * @returns {Uint8Array[]} 加密 advert 列表
 */
function parsePresenceBlob(raw) {
	try {
		const parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
		if (!parsed?.entries?.length) return []
		return parsed.entries.map(entry =>
			Uint8Array.from(Buffer.from(entry.data || '', 'base64')),
		).filter(bytes => bytes.byteLength)
	}
	catch {
		return []
	}
}

/**
 * 扫描到的 BT presence：验签 network advert 后写入可见池与 peer hint。
 * @param {Uint8Array} bytes 加密 network advert
 * @param {{ peripheralId: string }} meta 扫描 meta（至少 peripheralId）
 * @returns {Promise<{ verifiedNodeHash: string, body: object } | null>} 验签结果
 */
export async function acceptBtScannedPresence(bytes, meta) {
	const peripheralId = String(meta?.peripheralId || '').trim()
	if (!peripheralId || !bytes?.byteLength) return null
	const ingested = await ingestNetworkAdvert(bytes, meta)
	if (!ingested) return null
	const firstSeen = !visibleByHash.has(ingested.verifiedNodeHash)
	noteBtVisibleNode(ingested.verifiedNodeHash)
	noteAdvertPeerHints(ingested.verifiedNodeHash, ingested.body, meta)
	if (firstSeen)
		nodeDebug('p2p:bt peer visible', {
			peer: shortHash(ingested.verifiedNodeHash),
			peripheralId,
		})
	return ingested
}

/**
 * Bluetooth 发现提供者：固定 GATT service 传 presence / node signal，无 topic。
 * Win 默认 scan-only；非 Win 默认 dual（scan+advertise）。
 * @returns {import('../index.mjs').DiscoveryProvider} Bluetooth 发现提供者
 */
export function createBluetoothDiscoveryProvider() {
	const role = resolveBtRole()
	/** @type {Map<string, Uint8Array>} */
	const localPresence = new Map()
	/** @type {Map<string, Set<Function>>} */
	const signalListeners = new Map()
	/** @type {Map<string, number>} */
	const inspectedAt = new Map()
	let nobleRuntime = null
	let blenoRuntime = null
	let scanningStarted = false
	let advertisingStarted = false
	/** @type {string | null} */
	let localNodeHash = null

	/**
	 * @returns {Promise<any|null>} Bleno 实例
	 */
	async function ensurePeripheralRuntime() {
		if (role === 'scan') return null
		if (blenoRuntime) return blenoRuntime
		const bleno = await loadBleno()
		const presenceCharacteristic = new bleno.Characteristic({
			uuid: BT_CHARACTERISTIC_UUID,
			properties: ['read'],
			/**
			 * @param {*} _connection 连接
			 * @param {number} offset 偏移
			 * @param {Function} callback 结果
			 * @returns {void}
			 */
			onReadRequest(_connection, offset, callback) {
				try {
					const blob = serializePresenceBlob(localPresence)
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
			 * @param {*} _connection 连接
			 * @param {Buffer} data 信令 blob
			 * @param {number} _offset 偏移
			 * @param {boolean} _withoutResponse 无响应写
			 * @param {Function} callback 结果
			 * @returns {void}
			 */
			onWriteRequest(_connection, data, _offset, _withoutResponse, callback) {
				try {
					const parsed = JSON.parse(Buffer.from(data).toString('utf8'))
					const to = normalizeHex64(parsed?.to)
					const bytes = Uint8Array.from(Buffer.from(String(parsed?.data || ''), 'base64'))
					if (isHex64(to) && bytes.byteLength)
						for (const listener of signalListeners.get(to) || [])
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
				characteristics: [presenceCharacteristic, signalCharacteristic],
			}),
		])
		blenoRuntime = bleno
		return bleno
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function refreshAdvertising() {
		if (role === 'scan') return
		const bleno = await ensurePeripheralRuntime()
		if (!bleno) return
		if (!localPresence.size && !signalListeners.size) {
			if (advertisingStarted) {
				await bleno.stopAdvertisingAsync().catch(() => { })
				advertisingStarted = false
			}
			return
		}
		if (localPresence.size) serializePresenceBlob(localPresence)
		if (!advertisingStarted) {
			await bleno.startAdvertisingAsync(BT_DEVICE_NAME, [BT_SERVICE_UUID])
			advertisingStarted = true
		}
	}

	/**
	 * @param {*} peripheral Noble peripheral
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
			for (const bytes of parsePresenceBlob(raw))
				await acceptBtScannedPresence(bytes, { provider: 'bt', peripheralId: inspectKey })
		}
		catch { /* ignore */ }
		finally {
			try { await peripheral.disconnectAsync() } catch { /* ignore */ }
		}
	}

	/**
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
	 * @param {string} toNodeHash 目标
	 * @param {Uint8Array} bytes 载荷
	 * @returns {Promise<boolean>} 是否经 GATT 发出
	 */
	async function sendNodeSignalViaGatt(toNodeHash, bytes) {
		const hash = normalizeHex64(toNodeHash)
		const hint = getBtPeerHint(hash)
		if (!hint) return false
		const blob = Buffer.from(JSON.stringify({
			to: hash,
			data: Buffer.from(bytes).toString('base64'),
		}), 'utf8')
		if (blob.byteLength > MAX_SIGNAL_BLOB_BYTES)
			throw new Error(`p2p: bt signal blob exceeds ${MAX_SIGNAL_BLOB_BYTES} bytes`)
		await ensureScanRuntime()
		const noble = nobleRuntime
		const wantId = hint.peripheralId
		/**
		 * @returns {*|null} Noble 缓存中的 peripheral，未找到为 null
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
		 * @param {{ limit?: number, roomSecret?: string }} [options] 扫描选项
		 * @returns {Promise<string[]>} 群扫描时 BT 无群语义，返回空
		 */
		async listVisibleNodeHashes(options = {}) {
			if (options.roomSecret) return []
			const limit = Math.max(1, Number(options.limit) || 64)
			if (role !== 'scan') await ensureScanRuntime().catch(() => { })
			return listBtVisibleNodeHashes().slice(0, limit)
		},
		/**
		 * @param {string} nodeHash 目标
		 * @returns {Promise<boolean>} 有 BT hint 且 GATT 可达时为 true
		 */
		async connectToNode(nodeHash) {
			const hash = normalizeHex64(nodeHash)
			if (!isHex64(hash)) return false
			if (!getBtPeerHint(hash)) return false
			return await sendNodeSignalViaGatt(hash, new Uint8Array([0])).catch(() => false)
		},
		/**
		 * @param {() => Promise<{ nodeHash: string, advertBytes?: Uint8Array } | null>} getBeacon beacon
		 * @returns {Promise<() => void>} 停止 presence 广播
		 */
		async startPresence(getBeacon) {
			if (role === 'scan') return () => { }
			/**
			 * @returns {Promise<void>}
			 */
			const refresh = async () => {
				const body = await getBeacon?.()
				if (!body?.nodeHash || !body.advertBytes?.byteLength) return
				const hash = normalizeHex64(body.nodeHash)
				if (!isHex64(hash)) return
				localNodeHash = hash
				localPresence.set(hash, Uint8Array.from(body.advertBytes))
				noteBtVisibleNode(hash)
				await refreshAdvertising()
			}
			await refresh().catch(() => { })
			const timer = setInterval(() => { void refresh().catch(() => { }) }, 30_000)
			return () => {
				clearInterval(timer)
				if (localNodeHash) localPresence.delete(localNodeHash)
				void refreshAdvertising().catch(() => { })
			}
		},
		/**
		 * @param {string} toNodeHash 目标
		 * @param {Uint8Array} bytes 载荷
		 * @returns {Promise<void>}
		 */
		async sendNodeSignal(toNodeHash, bytes) {
			const ok = await sendNodeSignalViaGatt(toNodeHash, bytes)
			if (!ok) throw new Error('p2p: bt signal unavailable')
		},
		/**
		 * @param {string} localNodeHash 本机 hash
		 * @param {(bytes: Uint8Array) => void} onSignal 回调
		 * @returns {Promise<() => void>} 取消信令监听
		 */
		async listenNodeSignals(localNodeHash, onSignal) {
			if (role === 'scan') return () => { }
			const hash = normalizeHex64(localNodeHash)
			if (!isHex64(hash)) throw new Error('p2p: invalid nodeHash')
			await ensurePeripheralRuntime()
			if (!signalListeners.has(hash)) signalListeners.set(hash, new Set())
			signalListeners.get(hash).add(onSignal)
			await refreshAdvertising()
			return () => {
				signalListeners.get(hash)?.delete(onSignal)
				void refreshAdvertising().catch(() => { })
			}
		},
	}
}
