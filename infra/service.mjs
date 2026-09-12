import { isNodeInitialized } from '../node/instance.mjs'
import { setOverlayRateGate, clearOverlayRateGate } from '../overlay/index.mjs'
import { getLinkRegistry } from '../transport/link_registry.mjs'
import { attachNodeScopeMailbox } from '../transport/node_scope/features.mjs'
import { consumeToken } from '../utils/token_bucket.mjs'

import { attachInfraDebugLog, detachInfraDebugLog } from './debug_log.mjs'
import {
	applyPriorityToRegistry,
	clearInfraPriorityFromRegistry,
	getInfraPriority,
	setInfraPriority,
} from './priority.mjs'
import infraTunables from './tunables.json' with { type: 'json' }

/** @type {Map<string, { tokens: number, updatedAt: number }>} */
const overlayRateBuckets = new Map()

/** 安装 overlay 速率门 */
function installOverlayRateLimit() {
	const limits = {
		perMin: Math.max(1, Number(infraTunables.overlayRatePerMin) || 120),
		burst: Math.max(1, Number(infraTunables.overlayRateBurst) || 30),
	}
	setOverlayRateGate((sender, action) => {
		if (action !== 'route_req' && action !== 'relay') return true
		return consumeToken(overlayRateBuckets, sender, Date.now(), limits)
	})
}

/** 移除 overlay 速率门并清空桶 */
function removeOverlayRateLimit() {
	clearOverlayRateGate()
	overlayRateBuckets.clear()
}

/** @type {boolean} */
let infraRunning = false

/** @type {(() => void) | null} */
let mailboxDispose = null

/** @type {(() => void) | null} */
let debugDispose = null

/** @type {number | null} */
let savedMaxActive = null

/**
 * @returns {boolean} infra relay 是否在运行
 */
export function isInfraRunning() {
	return infraRunning
}

/**
 * 启动 public-good infra：overlay、mailbox、rate limit、priority、debug log。
 * @param {{ maxActive?: number, logger?: { info?: Function, warn?: Function, error?: Function, log?: Function } | null }} [options] - maxActive 与 debug logger
 * @returns {Promise<void>}
 */
export async function startInfra(options = {}) {
	if (!isNodeInitialized()) throw new Error('p2p: startInfra requires initNode')
	if (infraRunning) {
		if (options.maxActive != null) await getLinkRegistry().setMaxActive(options.maxActive)
		if (options.logger !== undefined) {
			detachInfraDebugLog()
			debugDispose = attachInfraDebugLog(options.logger ?? null)
		}
		applyPriorityToRegistry()
		return
	}
	const registry = getLinkRegistry()
	await registry.ensureRuntime()
	registry.ensureOverlayRouter()
	installOverlayRateLimit()
	savedMaxActive = registry.getMaxActive()
	if (options.maxActive != null)
		await registry.setMaxActive(options.maxActive)
	else
		await registry.setMaxActive(infraTunables.defaultMaxActive ?? savedMaxActive)
	if (!mailboxDispose) mailboxDispose = attachNodeScopeMailbox()
	const logger = options.logger === undefined ? console : options.logger ?? null
	debugDispose = attachInfraDebugLog(logger)
	applyPriorityToRegistry()
	infraRunning = true
}

/**
 * 卸掉 infra 自己挂的面（mailbox / rate / debug / priority / maxActive 恢复）。
 * 不碰用户另行 attach 的 wires，不绑信誉同步。
 * @returns {Promise<void>}
 */
export async function stopInfra() {
	if (!infraRunning) return
	debugDispose?.()
	debugDispose = null
	detachInfraDebugLog()
	clearInfraPriorityFromRegistry()
	removeOverlayRateLimit()
	mailboxDispose?.()
	mailboxDispose = null
	const registry = getLinkRegistry()
	if (savedMaxActive != null)
		await registry.setMaxActive(savedMaxActive)
	savedMaxActive = null
	infraRunning = false
}

/** 再导出：infra 路由加权配置（见 `priority.mjs`）。 */
export { getInfraPriority, setInfraPriority }
