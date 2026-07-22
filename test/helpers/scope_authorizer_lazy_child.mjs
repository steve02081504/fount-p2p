/**
 * 子进程：验证 registerScopeAuthorizer 不急切建 registry，并在首次 getLinkRegistry 时 flush。
 * 由 `scope_authorizer_lazy.test.mjs` spawn。
 *
 * argv[2] mode:
 * - register — 未 initNode 仅注册（不得抛）
 * - flush — pending authorizer 在 getLinkRegistry 后对入站 envelope 生效
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearLinkProviders, registerLinkProvider } from '../../link/providers/index.mjs'
import {
	configureLinkRegistry,
	getLinkRegistry,
	registerScopeAuthorizer,
	resetLinkRegistryForTests,
} from '../../transport/link_registry.mjs'

import { identity } from './identity.mjs'
import { initTestP2pNode } from './node.mjs'

const mode = String(process.argv[2] || 'register').trim()

/**
 * @param {object} options mock link 选项
 * @returns {object} 可手动 emit envelope 的 link
 */
function mockLink(options) {
	const envelopeListeners = new Set()
	const downListeners = new Set()
	return {
		ready: Promise.resolve(),
		/** @returns {string} 对端 nodeHash */
		get nodeHash() { return options.nodeHash },
		/** @returns {boolean} 始终为发起方 */
		get initiator() { return true },
		/** @returns {string} 提供者 id */
		get providerId() { return options.providerId },
		/** @returns {number} 提供者 level */
		get level() { return options.level },
		/** @returns {Promise<boolean>} 始终成功 */
		async send() { return true },
		/**
		 * @param {(envelope: object, remoteNodeHash: string) => void} callback 入站回调
		 * @returns {() => void} 取消订阅
		 */
		onEnvelope(callback) {
			envelopeListeners.add(callback)
			return () => envelopeListeners.delete(callback)
		},
		/**
		 * @param {(reason: string) => void} callback 断链回调
		 * @returns {() => void} 取消订阅
		 */
		onDown(callback) {
			downListeners.add(callback)
			return () => downListeners.delete(callback)
		},
		/**
		 * @param {string} [reason] 关闭原因
		 * @returns {Promise<void>}
		 */
		async close(reason = 'closed') {
			for (const listener of downListeners) listener(reason)
		},
		/** @returns {{ providerId: string }} 运行时统计 */
		stats() { return { providerId: options.providerId } },
		/**
		 * @param {object} envelope 信封
		 * @param {string} senderNodeHash 发送方
		 * @returns {void}
		 */
		emitEnvelope(envelope, senderNodeHash) {
			for (const listener of envelopeListeners)
				listener(envelope, senderNodeHash)
		},
	}
}

if (mode === 'register') {
	const unregister = registerScopeAuthorizer('lazy:', () => false)
	unregister()
	process.stdout.write('ok\n')
}
else if (mode === 'flush') {
	const dir = await mkdtemp(join(tmpdir(), 'fount-p2p-scope-auth-'))
	clearLinkProviders()
	try {
		await mkdir(dir, { recursive: true })
		initTestP2pNode({ nodeDir: dir })
		resetLinkRegistryForTests()
		configureLinkRegistry({ meshKeepalive: false, autoRegisterDiscoveryProviders: false, autoRegisterLinkProviders: false })
		const bob = identity(42)
		const decisions = []
		registerScopeAuthorizer('lazy:', async (_scope, sender) => {
			decisions.push(sender)
			return true
		})

		/** @type {ReturnType<typeof mockLink> | null} */
		let link = null
		registerLinkProvider({
			id: 'mock-lazy',
			level: 99,
			caps: { needsOfferAnswer: false },
			/** @returns {boolean} 始终可用 */
			isAvailable: () => true,
			/** @returns {boolean} 始终可达 */
			canReach: () => true,
			/**
			 * @param {{ nodeHash: string }} options dial 选项
			 * @returns {Promise<object>} mock link
			 */
			async dial(options) {
				link = mockLink({
					providerId: 'mock-lazy',
					level: 99,
					nodeHash: options.nodeHash,
				})
				return link
			},
		})

		const registry = getLinkRegistry()
		await registry.ensureRuntime()
		await registry.ensureLinkToNode(bob.nodeHash)
		if (!link) throw new Error('mock link not dialed')

		const received = []
		/** @type {() => void} */
		let resolveReceived
		const receivedPromise = new Promise(resolve => { resolveReceived = resolve })
		const stop = registry.subscribeScope('lazy:', (sender, envelope) => {
			received.push({ sender, envelope })
			resolveReceived()
		})
		link.emitEnvelope({ scope: 'lazy:x', action: 'ping', payload: null }, bob.nodeHash)
		await Promise.race([
			receivedPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error('envelope timeout')), 1000)),
		])
		stop()

		if (decisions.length !== 1 || decisions[0] !== bob.nodeHash)
			throw new Error(`authorizer not flushed: ${JSON.stringify(decisions)}`)
		if (received.length !== 1)
			throw new Error(`listener not reached: ${JSON.stringify(received)}`)

		process.stdout.write('ok\n')
		await registry.shutdown()
	}
	finally {
		clearLinkProviders()
		await rm(dir, { recursive: true, force: true })
	}
}
else
	throw new Error(`unknown mode: ${mode}`)
