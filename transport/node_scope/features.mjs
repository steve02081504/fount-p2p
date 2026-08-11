import { attachNodeScopeFedResponder } from '../../files/fed/responder.mjs'
import { attachMailboxWire } from '../../mailbox/wire.mjs'
import { attachPartWire } from '../../wire/part/ingress.mjs'
import { attachPartQueryWire } from '../../wire/part/query.mjs'

import {
	clearNodeScopeSubscribe,
	ensureNodeScope,
	getNodeScopeContext,
	getNodeScopeWire,
} from './wire.mjs'

/** @typedef {import('./wire.mjs').NodeScopeWire} NodeScopeWire */
/** @typedef {import('./wire.mjs').NodeScopeContext} NodeScopeContext */

/** @type {Set<() => void>} */
const nodeScopeFeatureDisposers = new Set()

/** @type {Map<string, { count: number, disposeCore: () => void }>} */
const featureAttachRefs = new Map()

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
		const current = featureAttachRefs.get(key)
		if (!current) return
		current.count--
		if (current.count > 0) return
		current.disposeCore()
		featureAttachRefs.delete(key)
	})
}

/**
 * @param {string} key - feature 去重键
 * @param {(wire: NodeScopeWire, context: NodeScopeContext) => () => void} attachCore - 首次 attach
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 引用计数包装的 dispose
 */
export function attachNodeScopeFeature(key, attachCore, options = {}) {
	ensureNodeScope(options)
	return attachFeatureRefCounted(key, () => attachCore(getNodeScopeWire(), getNodeScopeContext()))
}

/** @type {Record<string, (wire: NodeScopeWire, context: NodeScopeContext) => () => void>} */
const builtinFeatures = {
	/**
	 * @param {NodeScopeWire} wire node scope wire
	 * @param {NodeScopeContext} context 入站上下文
	 * @returns {() => void} 取消挂载的 dispose
	 */
	mailbox: (wire, context) => attachMailboxWire(context, wire),
	/**
	 * @param {NodeScopeWire} wire node scope wire
	 * @param {NodeScopeContext} context 入站上下文
	 * @returns {() => void} 取消挂载的 dispose
	 */
	part: (wire, context) => attachPartWire(context, wire),
	/**
	 * @param {NodeScopeWire} wire node scope wire
	 * @param {NodeScopeContext} context 入站上下文
	 * @returns {() => void} 取消挂载的 dispose
	 */
	partQuery: (wire, context) => attachPartQueryWire(context, wire),
	/**
	 * @param {NodeScopeWire} wire node scope wire
	 * @returns {() => void} 取消挂载的 dispose
	 */
	chunks: wire => attachNodeScopeFedResponder(wire),
}

/**
 * @param {keyof typeof builtinFeatures} key - 内置 feature 名
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 引用计数包装的 dispose
 */
function attachBuiltin(key, options = {}) {
	return attachNodeScopeFeature(key, builtinFeatures[key], options)
}

/**
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopeMailbox(options = {}) {
	return attachBuiltin('mailbox', options)
}

/**
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopePart(options = {}) {
	return attachBuiltin('part', options)
}

/**
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopePartQuery(options = {}) {
	return attachBuiltin('partQuery', options)
}

/**
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopeChunks(options = {}) {
	return attachBuiltin('chunks', options)
}

/**
 * 全业务 preset（part / partQuery / mailbox / chunks）。
 * @param {{ replicaUsername?: string }} [options] - 可选副本用户名
 * @returns {() => void} 取消全部 preset 挂载的 dispose
 */
export function attachNodeScopeDefaultFeatures(options = {}) {
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
	clearNodeScopeSubscribe()
}
