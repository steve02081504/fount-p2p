import { attachNodeScopeFedChunkResponder } from '../files/chunk_responder.mjs'
import { attachMailboxWire } from '../mailbox/wire.mjs'
import { attachPartWire } from '../wire/part_ingress.mjs'
import { attachPartQueryWire } from '../wire/part_query.mjs'

import { sendToNodeLink, subscribeScope } from './link_registry.mjs'

/** @type {Map<string, Set<(payload: unknown, peerId: string) => void>>} */
const nodeActionHandlers = new Map()

/** @type {Set<(context: NodeScopeContext, wire: NodeScopeWire) => void>} */
const nodeScopeWireHooks = new Set()

/** @type {NodeScopeContext} */
const nodeScopeContext = { replicaUsername: '' }

/** @type {NodeScopeWire | null} */
let nodeScopeWire = null

/** @type {(() => void) | null} */
let nodeScopeSubscribeCleanup = null

/** @type {Set<() => void>} */
const nodeScopeFeatureDisposers = new Set()

/** @type {Map<string, { count: number, disposeCore: () => void }>} */
const featureAttachRefs = new Map()

/**
 * @typedef {{ replicaUsername: string }} NodeScopeContext
 */

/**
 * @typedef {{
 *   on: (name: string, handler: (payload: unknown, peerId: string) => void) => () => void
 *   send: (name: string, payload: unknown, peerId: string | null) => void
 * }} NodeScopeWire
 */

/**
 * @param {string} peerId 对端 nodeHash
 * @param {string} action 动作名
 * @param {unknown} payload 载荷
 * @returns {Promise<boolean>} 是否成功发出
 */
const sendNodeAction = (peerId, action, payload) =>
	sendToNodeLink(peerId, { scope: 'node', action, payload })

/**
 * @returns {NodeScopeWire} node scope 的 wire 适配器
 */
function createNodeScopeWire() {
	return {
		/**
		 * @param {string} name - action 名
		 * @param {(payload: unknown, peerId: string) => void} handler - 入站处理器
		 * @returns {() => void} 取消注册的 dispose
		 */
		on(name, handler) {
			if (!nodeActionHandlers.has(name)) nodeActionHandlers.set(name, new Set())
			nodeActionHandlers.get(name).add(handler)
			return () => {
				const set = nodeActionHandlers.get(name)
				if (!set) return
				set.delete(handler)
				if (!set.size) nodeActionHandlers.delete(name)
			}
		},
		/**
		 * @param {string} name - action 名
		 * @param {unknown} payload - 出站载荷
		 * @param {string | null} peerId - 目标 peer，null 时忽略
		 * @returns {void}
		 */
		send(name, payload, peerId) {
			if (!peerId) return
			void sendNodeAction(peerId, name, payload).catch(() => { })
		},
	}
}

/**
 * @returns {boolean} 是否已订阅 node scope
 */
export function isNodeScopeSubscribed() {
	return nodeScopeSubscribeCleanup != null
}

/**
 * @param {string} action - action 名
 * @returns {boolean} 是否已挂载处理器
 */
export function hasNodeScopeAction(action) {
	return (nodeActionHandlers.get(action)?.size ?? 0) > 0
}

/**
 * @param {string} action - action 名
 * @returns {number} 已注册的处理器数量
 */
export function countNodeScopeActionHandlers(action) {
	return nodeActionHandlers.get(action)?.size ?? 0
}

/**
 * 测试/调试：直接派发已挂载的 node action。
 * @param {string} action - action 名
 * @param {unknown} payload - 载荷
 * @param {string} peerId - 发送方 nodeHash
 * @returns {boolean} 是否有处理器被调用
 */
export function dispatchNodeScopeAction(action, payload, peerId) {
	const handlers = nodeActionHandlers.get(action)
	if (!handlers?.size) return false
	for (const handler of handlers)
		try { handler(payload, peerId) } catch { /* ignore */ }
	return true
}

/**
 * @returns {NodeScopeWire | null} 当前 wire，未 ensure 时为 null
 */
export function getNodeScopeWire() {
	return nodeScopeWire
}

/**
 * @returns {NodeScopeContext} 可变 node scope 上下文
 */
export function getNodeScopeContext() {
	return nodeScopeContext
}

/**
 * 只订阅 node scope 派发，不挂任何 feature。
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消订阅的 dispose
 */
export function ensureNodeScope(options = {}) {
	if (options.replicaUsername != null)
		nodeScopeContext.replicaUsername = String(options.replicaUsername)
	if (nodeScopeSubscribeCleanup) return nodeScopeSubscribeCleanup
	nodeScopeSubscribeCleanup = subscribeScope('node', (senderNodeHash, envelope) => {
		const handlers = nodeActionHandlers.get(envelope.action)
		if (!handlers?.size) return
		for (const handler of handlers)
			try { handler(envelope.payload, senderNodeHash) } catch { /* ignore */ }
	})
	if (!nodeScopeWire) {
		nodeScopeWire = createNodeScopeWire()
		for (const hook of nodeScopeWireHooks)
			try { hook(nodeScopeContext, nodeScopeWire) } catch { /* ignore */ }
	}
	return nodeScopeSubscribeCleanup
}

/**
 * @param {(context: NodeScopeContext, wire: NodeScopeWire) => void} hook - wire 创建时回调
 * @returns {() => void} 取消注册的 dispose
 */
export function registerNodeScopeWireHook(hook) {
	nodeScopeWireHooks.add(hook)
	if (nodeScopeWire)
		try { hook(nodeScopeContext, nodeScopeWire) } catch { /* ignore */ }
	return () => nodeScopeWireHooks.delete(hook)
}

/**
 * @param {() => void} dispose - feature 卸载函数
 * @returns {() => void} 包装后的 dispose（同时从跟踪集移除）
 */
function trackFeatureDisposer(dispose) {
	nodeScopeFeatureDisposers.add(dispose)
	return () => {
		dispose()
		nodeScopeFeatureDisposers.delete(dispose)
	}
}

/**
 * 同一 feature 多次 attach 共享一份 wire；dispose 引用计数归零才卸。
 * @param {string} key - feature 去重键
 * @param {() => () => void} attachCore - 首次 attach 时执行，返回核心 dispose
 * @returns {() => void} 引用计数包装的 dispose
 */
function attachFeatureRefCounted(key, attachCore) {
	let entry = featureAttachRefs.get(key)
	if (!entry) {
		entry = { count: 0, disposeCore: attachCore() }
		featureAttachRefs.set(key, entry)
	}
	entry.count++
	return trackFeatureDisposer(() => {
		const cur = featureAttachRefs.get(key)
		if (!cur) return
		cur.count--
		if (cur.count > 0) return
		cur.disposeCore()
		featureAttachRefs.delete(key)
	})
}

/**
 * 自定义 node scope feature（与 mailbox/part 相同 refcount 语义）。
 * @param {string} key - feature 去重键
 * @param {(wire: NodeScopeWire, context: NodeScopeContext) => () => void} attachCore - 首次 attach 注册 handler，返回核心 dispose
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 引用计数包装的 dispose
 */
export function attachNodeScopeFeature(key, attachCore, options = {}) {
	ensureNodeScope(options)
	return attachFeatureRefCounted(key, () => attachCore(nodeScopeWire, nodeScopeContext))
}

/**
 * refcount 挂载 mailbox wire。
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopeMailbox(options = {}) {
	ensureNodeScope(options)
	return attachFeatureRefCounted('mailbox', () => attachMailboxWire(nodeScopeContext, nodeScopeWire))
}

/**
 * refcount 挂载 part ingress wire。
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopePart(options = {}) {
	ensureNodeScope(options)
	return attachFeatureRefCounted('part', () => attachPartWire(nodeScopeContext, nodeScopeWire))
}

/**
 * refcount 挂载 part_query wire。
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopePartQuery(options = {}) {
	ensureNodeScope(options)
	return attachFeatureRefCounted('partQuery', () => attachPartQueryWire(nodeScopeContext, nodeScopeWire))
}

/**
 * refcount 挂载 fed chunk responder。
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopeChunks(options = {}) {
	ensureNodeScope(options)
	return attachFeatureRefCounted('chunks', () =>
		attachNodeScopeFedChunkResponder(() => nodeScopeContext.replicaUsername, nodeScopeWire))
}

/**
 * 全业务 preset（等价旧 ensureNodeScopeRuntime 默认行为）。
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消全部 preset 挂载的 dispose
 */
export function attachUserRoomDefaultWires(options = {}) {
	const disposers = [
		attachNodeScopePart(options),
		attachNodeScopePartQuery(options),
		attachNodeScopeMailbox(options),
		attachNodeScopeChunks(options),
	]
	return () => {
		for (const dispose of disposers) dispose()
	}
}

/**
 * 卸掉 feature 挂载；可选保留 node scope 订阅。
 * @param {{ keepSubscribe?: boolean }} [options] - true 时保留 node scope 订阅
 * @returns {void}
 */
export function stopNodeScopeRuntime(options = {}) {
	for (const dispose of [...nodeScopeFeatureDisposers]) dispose()
	nodeScopeFeatureDisposers.clear()
	for (const entry of featureAttachRefs.values())
		try { entry.disposeCore() } catch { /* ignore */ }
	featureAttachRefs.clear()
	if (options.keepSubscribe) return
	nodeScopeSubscribeCleanup?.()
	nodeScopeSubscribeCleanup = null
	nodeScopeWire = null
	nodeActionHandlers.clear()
}
