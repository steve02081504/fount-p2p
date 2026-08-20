import { createNostrDiscoveryProvider } from '../../../discovery/nostr.mjs'
import { startFakeRelay } from '../../helpers/fake_relay.mjs'
import { identity } from '../../helpers/identity.mjs'

/**
 * 泄漏探测 workload 工厂：对真实 nostr provider 反复 `sendNodeSignal`。
 * 发送路径已复用共享 relay 会话，故连接数与堆都应保持有界（回归守卫）。
 * 每次调用创建独立的假中继 + provider，供不同测试各自隔离（避免共享 fixture 的 shutdown 互相踩）。
 * @returns {Promise<{ workload: (index: number) => Promise<void>, shutdown: () => Promise<void> }>} workload 与清理
 */
export async function createNostrSendWorkload() {
	const relay = await startFakeRelay(() => true)
	const peer = identity(2001)
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	return {
		/**
		 * @param {number} index 轮次
		 * @returns {Promise<void>} 发送一次 node signal
		 */
		async workload(index) {
			await provider.sendNodeSignal(peer.nodeHash, new Uint8Array([index & 0xff]))
		},
		/**
		 * @returns {Promise<void>} 关闭假中继与 provider
		 */
		async shutdown() {
			provider.dispose?.()
			await relay.stop()
		},
	}
}
