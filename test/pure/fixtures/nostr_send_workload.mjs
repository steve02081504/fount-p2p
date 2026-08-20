import { createNostrDiscoveryProvider } from '../../../discovery/nostr.mjs'
import { startFakeRelay } from '../../helpers/fake_relay.mjs'
import { identity } from '../../helpers/identity.mjs'

/**
 * 泄漏探测 workload：对真实 nostr provider 反复 `sendNodeSignal`。
 * 发送路径已复用共享 relay 会话，故连接数与堆都应保持有界（回归守卫）。
 */
const relay = await startFakeRelay(() => true)
const peer = identity(2001)
const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })

/**
 * @param {number} index 轮次
 * @returns {Promise<void>} 发送一次 node signal
 */
export async function workload(index) {
	await provider.sendNodeSignal(peer.nodeHash, new Uint8Array([index & 0xff]))
}

/**
 * @returns {Promise<void>} 关闭假中继与 provider
 */
export async function shutdown() {
	provider.dispose?.()
	await relay.stop()
}
