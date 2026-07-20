import { Buffer } from 'node:buffer'
import dgram from 'node:dgram'

const DEFAULT_PORT = 53531
const DEFAULT_GROUP = '239.255.42.99'

/**
 * 轻量 multicast 发现插件：不做完整 DNS-SD，只复用 mDNS 的 LAN multicast 发现思路。
 * 引用计数为 0 时关闭 UDP socket，避免 shutdown 后句柄拖住进程。
 *
 * @param {{ port?: number, group?: string }} [options] 组播端口与组地址
 * @returns {import('./index.mjs').DiscoveryProvider} mDNS 发现提供者
 */
export function createMdnsDiscoveryProvider(options = {}) {
	const port = Number(options.port) || DEFAULT_PORT
	const group = String(options.group || DEFAULT_GROUP)
	/** @type {import('node:dgram').Socket | null} */
	let socket = null
	let bound = false
	let bindPromise = null
	let refs = 0
	/** @type {Map<string, Set<Function>>} */
	const advertListeners = new Map()
	/** @type {Map<string, Set<Function>>} */
	const signalListeners = new Map()

	/**
	 * 懒创建或返回当前 UDP socket。
	 * @returns {import('node:dgram').Socket} 用于组播 bind/send 的 socket
	 */
	function getSocket() {
		return socket ||= dgram.createSocket({ type: 'udp4', reuseAddr: true })
	}

	/**
	 * 绑定 UDP socket 并注册组播消息处理器。
	 * @returns {Promise<void>}
	 */
	async function ensureBound() {
		if (bound) return
		if (!bindPromise)
			bindPromise = (async () => {
				const sock = getSocket()
				await new Promise((resolve, reject) => {
					sock.once('error', reject)
					sock.bind(port, '0.0.0.0', () => {
						sock.off('error', reject)
						sock.addMembership(group)
						sock.setMulticastTTL(1)
						resolve()
					})
				})
				// acquire 已全部释放：关掉刚 bind 的 socket，避免泄漏句柄。
				if (refs <= 0) {
					try { sock.close() } catch { /* ignore */ }
					if (socket === sock) socket = null
					bound = false
					return
				}
				sock.on('message', (raw, rinfo) => {
					let packet
					try { packet = JSON.parse(String(raw)) } catch { return }
					const listeners = packet.type === 'advert'
						? advertListeners.get(String(packet.topic || ''))
						: signalListeners.get(String(packet.topic || ''))
					if (!listeners?.size) return
					const bytes = Uint8Array.from(Buffer.from(String(packet.data || ''), 'base64'))
					const meta = {
						provider: 'mdns',
						address: String(rinfo?.address || ''),
					}
					for (const listener of listeners)
						listener(bytes, meta)
				})
				bound = true
			})()
				.finally(() => {
					if (!bound) bindPromise = null
				})
		await bindPromise
	}

	/**
	 * 向组播组发送 advert 或 signal 包。
	 * @param {'advert' | 'signal'} type 包类型
	 * @param {string} topic topic 名称
	 * @param {Uint8Array} bytes 载荷字节
	 * @returns {Promise<void>}
	 */
	async function multicast(type, topic, bytes) {
		await ensureBound()
		const sock = getSocket()
		const packet = Buffer.from(JSON.stringify({
			type,
			topic,
			data: Buffer.from(bytes).toString('base64'),
		}))
		await new Promise((resolve, reject) => {
			sock.send(packet, port, group, error => error ? reject(error) : resolve())
		})
	}

	/**
	 * 占用 socket；归还后若无引用则关闭。
	 * @returns {() => void} 释放函数
	 */
	function acquire() {
		refs++
		void ensureBound().catch(() => { })
		return () => {
			refs = Math.max(0, refs - 1)
			if (refs > 0 || !socket) return
			try { socket.close() } catch { /* ignore */ }
			socket = null
			bound = false
			bindPromise = null
		}
	}

	/**
	 * 向 topic bucket 注册监听器。
	 * @param {Map<string, Set<Function>>} bucket topic → 监听器集合
	 * @param {string} topic 订阅 topic
	 * @param {Function} listener 回调函数
	 * @returns {() => void} 取消订阅函数
	 */
	function addListener(bucket, topic, listener) {
		if (!bucket.has(topic)) bucket.set(topic, new Set())
		bucket.get(topic).add(listener)
		const release = acquire()
		return () => {
			const set = bucket.get(topic)
			if (!set) {
				release()
				return
			}
			set.delete(listener)
			if (!set.size) bucket.delete(topic)
			release()
		}
	}

	return {
		id: 'mdns',
		priority: 10,
		caps: { canDiscover: true, canSignal: true, canRelay: false },
		/**
		 * 周期性组播广播 advert（首发后台，不阻塞调用方）。
		 * @param {string} topic advert 主题
		 * @param {Uint8Array} bytes advert 载荷
		 * @returns {Promise<() => void>} 取消广播函数
		 */
		async advertise(topic, bytes) {
			const release = acquire()
			void multicast('advert', topic, bytes).catch(() => { })
			const timer = setInterval(() => { void multicast('advert', topic, bytes).catch(() => { }) }, 30_000)
			return () => {
				clearInterval(timer)
				release()
			}
		},
		/**
		 * 订阅组播 advert（立即返回；UDP bind 后台完成）。
		 * @param {string} topic advert 主题
		 * @param {Function} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消订阅函数
		 */
		async subscribe(topic, onAdvert) {
			return addListener(advertListeners, topic, onAdvert)
		},
		/**
		 * 组播发送信令（忽略单播目标）。
		 * @param {string} topic 信令 topic
		 * @param {string} _to 目标标识（未使用）
		 * @param {Uint8Array} bytes 信令载荷
		 * @returns {Promise<void>}
		 */
		async sendSignal(topic, _to, bytes) {
			const release = acquire()
			try {
				await multicast('signal', topic, bytes)
			}
			finally {
				release()
			}
		},
		/**
		 * 订阅组播信令（立即返回；UDP bind 后台完成）。
		 * @param {string} topic 信令 topic
		 * @param {Function} onSignal 信令回调
		 * @returns {Promise<() => void>} 取消订阅函数
		 */
		async onSignal(topic, onSignal) {
			return addListener(signalListeners, topic, onSignal)
		},
	}
}
