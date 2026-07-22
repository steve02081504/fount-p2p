import path from 'node:path'

import { createFsEntityStore } from './entity_store.mjs'
import { defaultSignalingRuntimeConfig, resolveSignalingRuntimeConfig } from './signaling_config.mjs'

/** @typedef {{ warn?: (...args: unknown[]) => void, error?: (...args: unknown[]) => void, info?: (...args: unknown[]) => void, log?: (...args: unknown[]) => void }} NodeLogger */

/** @typedef {import('./signaling_config.mjs').SignalingRuntimeConfig} SignalingRuntimeConfig */

/**
 * @typedef {{
 *   nodeDir: string
 *   entityStore: import('./entity_store.mjs').EntityStore
 *   logger: NodeLogger | null
 *   signaling: SignalingRuntimeConfig
 * }} NodeRuntime
 */

/** @type {NodeRuntime | null} */
let runtime = null

/** @type {Set<(event: string, payload?: unknown) => void>} */
const changeListeners = new Set()

/**
 * @param {{ nodeDir: string, entityStore?: import('./entity_store.mjs').EntityStore }} options - 节点目录与可选 entity store
 * @returns {NodeRuntime} 初始化后的运行时
 */
export function initNode(options) {
	if (runtime) throw new Error('p2p: initNode already called — use setNodeLogger / setSignalingRuntimeConfig or resetNodeForTests')
	if (options?.logger !== undefined || options?.signaling !== undefined)
		throw new Error('p2p: initNode only accepts nodeDir/entityStore — use setNodeLogger / setSignalingRuntimeConfig')
	const nodeDir = path.resolve(String(options.nodeDir || '').trim())
	if (!nodeDir) throw new Error('p2p: initNode requires nodeDir')
	const entityStore = options.entityStore ?? createFsEntityStore(path.join(nodeDir, 'entities'))
	runtime = {
		nodeDir,
		entityStore,
		logger: console,
		signaling: resolveSignalingRuntimeConfig(),
	}
	return runtime
}

/**
 * @returns {NodeRuntime} 当前节点运行时
 */
export function getNode() {
	if (!runtime) throw new Error('p2p: node not initialized — call initNode() first')
	return runtime
}

/**
 * @returns {boolean} 是否已调用 initNode
 */
export function isNodeInitialized() {
	return runtime != null
}

/**
 * @param {NodeLogger | null} logger - 节点日志器，null 表示静默
 * @returns {void}
 */
export function setNodeLogger(logger) {
	if (!runtime) throw new Error('p2p: setNodeLogger requires initNode')
	runtime.logger = logger ?? null
}

/**
 * @param {Partial<SignalingRuntimeConfig>} config - signaling 运行时补丁
 * @returns {void}
 */
export function setSignalingRuntimeConfig(config) {
	if (!runtime) throw new Error('p2p: setSignalingRuntimeConfig requires initNode')
	runtime.signaling = resolveSignalingRuntimeConfig({ ...runtime.signaling, ...config })
	emitNodeChange('signaling-changed', runtime.signaling)
}

/**
 * @returns {SignalingRuntimeConfig} 当前 signaling 配置
 */
export function getSignalingRuntimeConfig() {
	return runtime?.signaling ?? defaultSignalingRuntimeConfig()
}

/**
 * @returns {string} 节点数据目录绝对路径
 */
export function getNodeDir() {
	return getNode().nodeDir
}

/**
 * @returns {import('./entity_store.mjs').EntityStore} 当前 entity store
 */
export function getEntityStore() {
	return getNode().entityStore
}

/**
 * @returns {NodeLogger | null} 当前节点日志器
 */
export function getNodeLogger() {
	return runtime?.logger ?? null
}

/**
 * @param {string} event - 变更事件名
 * @param {unknown} [payload] - 事件载荷
 * @returns {void}
 */
export function emitNodeChange(event, payload) {
	for (const listener of changeListeners)
		try { listener(event, payload) }
		catch { /* ignore */ }
}

/**
 * @param {(event: string, payload?: unknown) => void} listener - 变更回调
 * @returns {() => void} 取消监听的 dispose
 */
export function onNodeChange(listener) {
	changeListeners.add(listener)
	return () => changeListeners.delete(listener)
}

/**
 * 测试专用：重置节点运行时。
 * @returns {void}
 */
export function resetNodeForTests() {
	runtime = null
	changeListeners.clear()
}
