/** @typedef {{ id: string, priority: number, caps: { canDiscover?: boolean, canSignal?: boolean, canRelay?: boolean }, advertise?: (topic: string, bytes: Uint8Array) => (() => void) | Promise<() => void>, subscribe?: (topic: string, onAdvert: (bytes: Uint8Array, meta?: object) => void) => (() => void) | Promise<() => void>, sendSignal?: (topic: string, to: string, bytes: Uint8Array) => boolean | void | Promise<boolean | void>, onSignal?: (topic: string, onSignal: (bytes: Uint8Array, meta?: object) => void) => (() => void) | Promise<() => void> }} DiscoveryProvider */

/** @type {Map<string, DiscoveryProvider>} */
const providers = new Map()

/**
 * 注册 discovery provider。
 * @param {DiscoveryProvider} provider 发现提供者
 * @returns {() => void} 注销函数
 */
export function registerDiscoveryProvider(provider) {
	if (!provider?.id) throw new Error('p2p: discovery provider requires id')
	providers.set(String(provider.id), provider)
	return () => unregisterDiscoveryProvider(provider.id)
}

/**
 * 注销 discovery provider。
 * @param {string} id 提供者 id
 * @returns {void}
 */
export function unregisterDiscoveryProvider(id) {
	providers.delete(String(id))
}

/**
 * 清空全部 discovery provider。
 * @returns {void}
 */
export function clearDiscoveryProviders() {
	providers.clear()
}

/**
 * 列出已注册的 discovery provider（按 priority 排序）。
 * @returns {DiscoveryProvider[]} 提供者列表
 */
export function listDiscoveryProviders() {
	return [...providers.values()].sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0))
}

/**
 * 并行启动各 provider 的 async 钩子；单路失败静默。
 * @param {DiscoveryProvider[]} list 提供者列表
 * @param {(provider: DiscoveryProvider) => Promise<(() => void) | null | undefined>} run 单路启动
 * @returns {Promise<() => void>} 统一取消函数
 */
async function startProvidersParallel(list, run) {
	const settled = await Promise.all(list.map(async provider => {
		try {
			const cleanup = await run(provider)
			return typeof cleanup === 'function' ? cleanup : null
		}
		catch {
			return null
		}
	}))
	const cleanups = settled.filter(Boolean)
	return () => {
		for (const cleanup of cleanups)
			try { cleanup() } catch { /* ignore */ }
	}
}

/**
 * 通过所有可用 provider 广播 topic advert。
 * 单路失败静默（正常降级）；其它 provider 仍可成功。
 * @param {string} topic advert 主题
 * @param {Uint8Array} bytes advert 载荷
 * @returns {Promise<() => void>} 统一取消函数
 */
export async function advertiseTopic(topic, bytes) {
	const list = listDiscoveryProviders().filter(provider => provider.caps?.canDiscover && typeof provider.advertise === 'function')
	return startProvidersParallel(list, provider => provider.advertise(topic, bytes))
}

/**
 * 通过所有可用 provider 订阅 topic advert。
 * 单路失败静默（正常降级）。
 * @param {string} topic advert 主题
 * @param {(bytes: Uint8Array, meta?: object) => void} onAdvert advert 回调
 * @returns {Promise<() => void>} 统一取消函数
 */
export async function subscribeTopic(topic, onAdvert) {
	const list = listDiscoveryProviders().filter(provider => provider.caps?.canDiscover && typeof provider.subscribe === 'function')
	return startProvidersParallel(list, provider => provider.subscribe(topic, onAdvert))
}

/**
 * 通过 discovery provider 发送信令。
 * provider 返回 `false` = 本路不可达（正常降级，不计成功）；其它返回值 / void = 已投递。
 * 单路 throw 静默；全部未投递才 throw。
 * @param {string} topic 信令 topic
 * @param {string} to 目标节点标识
 * @param {Uint8Array} bytes 信令载荷
 * @returns {Promise<void>}
 */
export async function sendSignal(topic, to, bytes) {
	const capable = listDiscoveryProviders().filter(provider => provider.caps?.canSignal && typeof provider.sendSignal === 'function')
	if (!capable.length) throw new Error('p2p: no discovery provider can signal')
	let sent = false
	let lastError = null
	await Promise.all(capable.map(async provider => {
		try {
			if (await Promise.resolve(provider.sendSignal(topic, to, bytes)) !== false)
				sent = true
		}
		catch (error) {
			lastError = error
		}
	}))
	if (!sent) throw lastError || new Error('p2p: no discovery provider delivered signal')
}

/**
 * 通过所有可用 provider 监听信令。
 * 单路失败静默（正常降级）。
 * @param {string} topic 信令 topic
 * @param {(bytes: Uint8Array, meta?: object) => void} onSignal 信令回调
 * @returns {Promise<() => void>} 统一取消函数
 */
export async function listenSignals(topic, onSignal) {
	const list = listDiscoveryProviders().filter(provider => provider.caps?.canSignal && typeof provider.onSignal === 'function')
	return startProvidersParallel(list, provider => provider.onSignal(topic, onSignal))
}
