/**
 * 共享 relay 测试初始化：注入内存存储 IO、复位池状态并播种公共默认。
 * @param {{ clearSeededRelays?: boolean, disableNip66Discovery?: boolean }} [options] 选项
 * @returns {Promise<{ relays: object, flushRelayStateNow: () => void, storage: { data: () => object | null } }>} 测试句柄
 */
export async function setupRelayTests(options = {}) {
	const relays = await import('../../discovery/nostr/relays.mjs')
	let data = null
	relays.setRelayStorageIOForTests({
		/**
		 * 读取测试存储。
		 * @returns {object | null} 存储数据
		 */
		read: () => data,
		/**
		 * 写入测试存储。
		 * @param {object} value 存储数据
		 * @returns {void}
		 */
		write: value => { data = value },
	})
	relays.resetNostrRelaysForTests()
	relays.loadRelayPool()
	if (options.clearSeededRelays) relays.clearRelayPoolForTests()
	if (options.disableNip66Discovery) relays.setNostrRelayDiscoveryEnabledForTests(false)
	return {
		relays,
		flushRelayStateNow: relays.flushRelayStateNow,
		storage: {
			/**
			 * 返回当前内存存储数据。
			 * @returns {object | null} 存储数据
			 */
			data: () => data,
		},
	}
}
