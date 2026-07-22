import { getLocalDataRevision } from '../node/local_data_revision.mjs'

/** @type {Map<string, { graph: Map<string, object>, builtAt: number, revision: number, dataRevision: number }>} */
const cacheByUsername = new Map()
let revision = 0

const DEFAULT_TTL_MS = 30_000

/**
 * 显式失效（测试 / 特殊路径）；常态依赖 local_data_revision。
 * @returns {void}
 */
export function invalidateTrustGraphCache() {
	cacheByUsername.clear()
	revision++
}

/**
 * @param {string} username 副本用户名 登录名（缓存键，与 buildMergedGraph 一致）
 * @param {() => Promise<Map<string, object>>} build 构建函数
 * @param {number} [ttlMs=30000] TTL
 * @returns {Promise<Map<string, object>>} 合并后的信任图
 */
export async function getCachedTrustGraph(username, build, ttlMs = DEFAULT_TTL_MS) {
	const key = String(username || '')
	const now = Date.now()
	const dataRevision = getLocalDataRevision()
	const cached = cacheByUsername.get(key)
	if (
		cached
		&& cached.revision === revision
		&& cached.dataRevision === dataRevision
		&& now - cached.builtAt < ttlMs
	)
		return cached.graph

	const graph = await build()
	cacheByUsername.set(key, { graph, builtAt: now, revision, dataRevision })
	return graph
}
