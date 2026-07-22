import { getLinkRegistry } from '../transport/link_registry.mjs'

/** @type {Array<() => void>} */
const cleanups = []

/**
 * 挂载 registry link/overlay/node scope 调试日志。
 * @param {{ info?: Function, warn?: Function, error?: Function, log?: Function } | null} logger - 日志输出目标，null 表示静默
 * @returns {() => void} 取消 debug 监听的 dispose
 */
export function attachInfraDebugLog(logger) {
	detachInfraDebugLog()
	if (!logger) return () => { }
	const registry = getLinkRegistry()
	/**
	 * @param {'info' | 'warn' | 'error' | 'log'} level - 日志级别
	 * @param {string} message - 日志消息
	 * @param {object} [extra] - 附加字段
	 */
	const log = (level, message, extra) => {
		logger?.[level]?.(message, extra)
	}
	cleanups.push(registry.onLinkUp((nodeHash, link) => {
		log('info', 'p2p:infra link up', {
			nodeHash,
			providerId: link?.providerId,
			level: link?.level,
		})
	}))
	cleanups.push(registry.onLinkDown((nodeHash, reason) => {
		log('info', 'p2p:infra link down', { nodeHash, reason })
	}))
	cleanups.push(registry.subscribeScope('overlay', (from, envelope) => {
		log('info', 'p2p:infra overlay', {
			from,
			action: envelope?.action,
			path: envelope?.payload?.path,
		})
	}))
	cleanups.push(registry.subscribeScope('node', (from, envelope) => {
		log('info', 'p2p:infra node', {
			from,
			action: envelope?.action,
		})
	}))
	return detachInfraDebugLog
}

/**
 * 卸掉 infra debug 监听。
 * @returns {void}
 */
export function detachInfraDebugLog() {
	for (const cleanup of cleanups.splice(0))
		try { cleanup() } catch { /* ignore */ }
}
