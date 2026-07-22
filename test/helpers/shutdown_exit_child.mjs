/**
 * 子进程：init → ensureRuntime → shutdown，然后自然退出。
 * 由 `shutdown_exit.test.mjs` spawn；勿在父测试进程内直接跑（`--test-force-exit` 会掩盖泄漏）。
 * 与生产相同：默认公网 nostr + lan + BT 暖机（无 relayOverride）。
 *
 * argv[2]：ensureRuntime 后、shutdown 前额外等待（毫秒）；写出一行 `shutdown` 到 stdout，供父进程计量 shutdown→exit。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearDiscoveryProviders } from '../../discovery/index.mjs'
import { clearLinkProviders } from '../../link/providers/index.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'

import { identity } from './identity.mjs'

const warmMs = Math.max(0, Number(process.argv[2] || 0) || 0)

const dir = await mkdtemp(join(tmpdir(), 'fount-p2p-shutdown-exit-'))
await mkdir(dir, { recursive: true })
clearLinkProviders()
clearDiscoveryProviders()
const registry = createLinkRegistry({
	localIdentity: identity(91),
	autoRegisterDiscoveryProviders: true,
	autoRegisterLinkProviders: true,
	meshKeepalive: false,
})
await registry.ensureRuntime()
await registry.whenListening()
if (warmMs) await new Promise(resolve => setTimeout(resolve, warmMs))
process.stdout.write('shutdown\n')
await registry.shutdown()
clearLinkProviders()
clearDiscoveryProviders()
await rm(dir, { recursive: true, force: true })
