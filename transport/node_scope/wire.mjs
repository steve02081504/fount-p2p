import { subscribeScope, sendToNodeLink } from '../link_registry.mjs'

/** @typedef {import('../../wire/adapter.mjs').WireAdapter} NodeScopeWire */
/** @typedef {{ replicaUsername: string }} NodeScopeContext */

/** @type {Map<string, Set<(payload: unknown, peerId: string) => void>>} */
const nodeActionHandlers = new Map()

/** @type {NodeScopeContext} */
const nodeScopeContext = { replicaUsername: '' }

/** @type {NodeScopeWire | null} */
let nodeScopeWire = null

/** @type {(() => void) | null} */
let nodeScopeSubscribeCleanup = null

/**
 * @returns {NodeScopeWire} node scope 的 wire 适配器
 */
function createNodeScopeWire() {
	return {
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
		send(name, payload, peerId) {
			if (!peerId) return
			void sendToNodeLink(peerId, { scope: 'node', action: name, payload }).catch(() => { })
		},
	}
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
	nodeScopeWire ||= createNodeScopeWire()
	return nodeScopeSubscribeCleanup
}

/**
 * 卸掉 scope 订阅与 wire（feature 须先卸）。
 * @returns {void}
 */
export function clearNodeScopeSubscribe() {
	nodeScopeSubscribeCleanup?.()
	nodeScopeSubscribeCleanup = null
	nodeScopeWire = null
	nodeActionHandlers.clear()
}
