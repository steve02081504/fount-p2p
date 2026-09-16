/**
 * 测试用 discovery provider（list+connect API）。
 * @param {string} [id='mock-discovery'] provider id
 * @returns {import('../../discovery/index.mjs').DiscoveryProvider & {
 *   publishAdvert: (nodeHash: string, bytes: Uint8Array) => void,
 *   publishGroupAdvert: (roomSecret: string, nodeHash: string, bytes: Uint8Array) => void,
 * }} 可发布 advert 的 mock discovery provider
 */
export function createMockDiscoveryProvider(id = 'mock-discovery') {
	/** @type {Map<string, Uint8Array>} */
	const advertsByNode = new Map()
	/** @type {Map<string, Set<Function>>} */
	const advertListeners = new Map()
	/** @type {Map<string, Set<Function>>} */
	const groupAdvertListeners = new Map()
	/** @type {Map<string, Set<Function>>} */
	const signalListeners = new Map()
	/** @type {Set<string>} */
	const visible = new Set()
	/** @type {Map<string, Set<string>>} */
	const visibleByGroup = new Map()

	/**
	 * @param {string} nodeHash 节点 hash
	 * @param {Uint8Array} bytes advert 字节
	 * @returns {void}
	 */
	function publishAdvert(nodeHash, bytes) {
		advertsByNode.set(nodeHash, bytes)
		visible.add(nodeHash)
		for (const listener of advertListeners.get(nodeHash) || [])
			listener(bytes, { provider: id })
	}

	/**
	 * @param {string} roomSecret 房间密钥
	 * @param {string} nodeHash 节点 hash
	 * @param {Uint8Array} bytes advert 字节
	 * @returns {void}
	 */
	function publishGroupAdvert(roomSecret, nodeHash, bytes) {
		const key = String(roomSecret || '')
		if (!visibleByGroup.has(key)) visibleByGroup.set(key, new Set())
		visibleByGroup.get(key).add(nodeHash)
		for (const listener of groupAdvertListeners.get(key) || [])
			listener(bytes, { provider: id })
	}

	return {
		id,
		priority: 1,
		caps: { canDiscover: true, canSignal: true, canRelay: false },
		publishAdvert,
		publishGroupAdvert,
		/**
		 * @param {{ limit?: number, roomSecret?: string }} [options] 扫描选项
		 * @returns {Promise<string[]>} 可见 nodeHash 列表
		 */
		async listVisibleNodeHashes(options = {}) {
			const limit = Math.max(1, Number(options.limit) || 64)
			if (options.roomSecret) {
				const groupVisible = visibleByGroup.get(String(options.roomSecret)) || new Set()
				return [...groupVisible].slice(0, limit)
			}
			return [...visible].slice(0, limit)
		},
		/**
		 * @param {string} nodeHash 目标 nodeHash
		 * @returns {Promise<boolean>} 节点在可见池中时为 true
		 */
		async connectToNode(nodeHash) {
			return visible.has(nodeHash)
		},
		/**
		 * @param {() => Promise<object | null>} getBeacon 本机 beacon 工厂
		 * @returns {Promise<() => void>} 停止 presence
		 */
		async startPresence(getBeacon) {
			/**
			 * @returns {Promise<void>}
			 */
			const publish = async () => {
				const beacon = await getBeacon?.()
				if (!beacon?.nodeHash) return
				const bytes = beacon.advertBytes || new Uint8Array([1])
				publishAdvert(beacon.nodeHash, bytes)
			}
			void publish()
			const timer = setInterval(() => { void publish() }, 1000)
			return () => clearInterval(timer)
		},
		/**
		 * @param {string} roomSecret 房间密钥
		 * @param {() => Promise<object | null>} getBeacon 群 beacon 工厂
		 * @returns {Promise<() => void>} 停止群 presence
		 */
		async startGroupPresence(roomSecret, getBeacon) {
			const key = String(roomSecret || '')
			/**
			 * @returns {Promise<void>}
			 */
			const publish = async () => {
				const beacon = await getBeacon?.()
				if (!beacon?.nodeHash) return
				const bytes = beacon.advertBytes || new Uint8Array([1])
				publishGroupAdvert(key, beacon.nodeHash, bytes)
				visible.add(beacon.nodeHash)
			}
			void publish()
			const timer = setInterval(() => { void publish() }, 1000)
			return () => clearInterval(timer)
		},
		/**
		 * @param {string} nodeHash 节点 hash
		 * @param {{ roomSecret?: string }} [options] 带 roomSecret 时写入群池
		 * @returns {void}
		 */
		noteVisibleNode(nodeHash, options = {}) {
			if (options.roomSecret) {
				const key = String(options.roomSecret)
				if (!visibleByGroup.has(key)) visibleByGroup.set(key, new Set())
				visibleByGroup.get(key).add(nodeHash)
				return
			}
			visible.add(nodeHash)
		},
		/**
		 * @param {string} toNodeHash 目标 nodeHash
		 * @param {Uint8Array} bytes 信令载荷
		 * @returns {Promise<void>}
		 */
		async sendNodeSignal(toNodeHash, bytes) {
			for (const listener of signalListeners.get(toNodeHash) || [])
				queueMicrotask(() => listener(bytes))
		},
		/**
		 * @param {string} localNodeHash 本机 nodeHash
		 * @param {(bytes: Uint8Array) => void} onSignal 信令回调
		 * @returns {Promise<() => void>} 取消监听
		 */
		async listenNodeSignals(localNodeHash, onSignal) {
			if (!signalListeners.has(localNodeHash)) signalListeners.set(localNodeHash, new Set())
			signalListeners.get(localNodeHash).add(onSignal)
			return () => signalListeners.get(localNodeHash)?.delete(onSignal)
		},
		/**
		 * @param {string} nodeHash 目标 nodeHash
		 * @param {(bytes: Uint8Array, meta: object) => void} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消监听
		 */
		async watchNodeAdvert(nodeHash, onAdvert) {
			if (!advertListeners.has(nodeHash)) advertListeners.set(nodeHash, new Set())
			advertListeners.get(nodeHash).add(onAdvert)
			if (advertsByNode.has(nodeHash)) onAdvert(advertsByNode.get(nodeHash), { provider: id })
			return () => advertListeners.get(nodeHash)?.delete(onAdvert)
		},
		/**
		 * @param {string} roomSecret 房间密钥
		 * @param {(bytes: Uint8Array, meta: object) => void} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消监听
		 */
		async watchGroupAdverts(roomSecret, onAdvert) {
			const key = String(roomSecret || '')
			if (!groupAdvertListeners.has(key)) groupAdvertListeners.set(key, new Set())
			groupAdvertListeners.get(key).add(onAdvert)
			return () => groupAdvertListeners.get(key)?.delete(onAdvert)
		},
	}
}
