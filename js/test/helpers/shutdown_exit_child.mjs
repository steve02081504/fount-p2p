/**
 * 子进程：init → ensureRuntime → shutdown，然后自然退出。
 * 由 `shutdown_exit.test.mjs` spawn；勿在父测试进程内直接跑（`--test-force-exit` 会掩盖泄漏）。
 *
 * 刻意保留生产路径的全部通道注册（lan + nostr + link providers 含 ble_gatt），只把 nostr 钉到
 * 父进程起的本地假 relay：走公网 relay 时该用例的判定会被网络往返污染（同一份代码时快时慢），
 * 而 shutdown→exit 的预算要测的是本进程自己的收尾。
 *
 * argv[2]：ensureRuntime 后、shutdown 前额外等待（毫秒）
 * argv[3]：本地假 relay 的 `ws://127.0.0.1:<port>` 地址
 * 写出一行 `shutdown` 到 stdout，供父进程计量 shutdown→exit；另写出真正连过的 relay 条数（探测/发布留痕，
 * 冷启动播种进池、却从未连过的公网项不计），父进程据此断言没碰公网。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearDiscoveryProviders } from '../../discovery/index.mjs'
import { getPoolByUrl } from '../../discovery/nostr/relays.mjs'
import { clearLinkProviders } from '../../link/providers/index.mjs'
import { setSignalingRuntimeConfig } from '../../node/instance.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'

import { identity } from './identity.mjs'
import { initTestP2pNode } from './node.mjs'

const warmMs = Math.max(0, Number(process.argv[2] || 0) || 0)
const relayUrl = process.argv[3]
if (!relayUrl) throw new Error('shutdown_exit_child: argv[3] must be the local relay URL')

const dir = await mkdtemp(join(tmpdir(), 'fount-p2p-shutdown-exit-'))
clearLinkProviders()
clearDiscoveryProviders()
initTestP2pNode({ nodeDir: dir })
setSignalingRuntimeConfig({ channels: { nostr: { relay: [relayUrl] } } })
const registry = createLinkRegistry({
	localIdentity: identity(91),
	autoRegisterDiscoveryProviders: true,
	autoRegisterLinkProviders: true,
	meshKeepalive: false,
})
await registry.ensureRuntime()
await registry.whenListening()
if (warmMs) await new Promise(resolve => setTimeout(resolve, warmMs))
const contacted = [...getPoolByUrl().values()]
	.filter(entry => entry.rttMs != null || entry.successCount > 0 || entry.failureCount > 0)
	.map(entry => entry.url)
process.stdout.write(`relay-count ${contacted.length}\n`)
process.stdout.write('shutdown\n')
await registry.shutdown()
clearLinkProviders()
clearDiscoveryProviders()
await rm(dir, { recursive: true, force: true })
