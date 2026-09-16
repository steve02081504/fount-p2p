import { randomUUID } from 'node:crypto'

import { resolveNodeHash } from '../chunk/provider_registry.mjs'
import { canonicalizeFanoutTargets, fanoutFedFetch } from '../fetch_fanout.mjs'

/**
 * inflight + pending wait + fanout 共用骨架。
 * 规范化目标集并拼入 inflight key：`fanoutTargets` 为数组（含空）即定向模式，undefined 为 node-scope public 模式。
 * @template T
 * @param {{
 *   inflight: { acquire: (key: string, start: () => { done: Promise<T | null>, cancel: () => void }) => Promise<T | null> | null },
 *   inflightKeyBase: string,
 *   username: string,
 *   action: string,
 *   registerWait: (requestId: string) => { done: Promise<T | null>, cancel: () => void },
 *   buildPayload: (requestId: string, nodeHash: string) => object,
 *   fanoutTargets?: string[],
 * }} options 选项
 * @returns {Promise<T | null> | null} 共享 Promise；队满为 null
 */
export function beginFedFanoutFetch({
	inflight,
	inflightKeyBase,
	username,
	action,
	registerWait,
	buildPayload,
	fanoutTargets,
}) {
	const targeted = Array.isArray(fanoutTargets)
	const canonicalTargets = targeted ? canonicalizeFanoutTargets(fanoutTargets) : undefined
	const inflightKey = `${inflightKeyBase}\0${targeted ? 'targeted' : 'public'}` + (canonicalTargets?.length ? `\0${canonicalTargets.join('\0')}` : '')
	return inflight.acquire(inflightKey, () => {
		const requestId = randomUUID()
		const wait = registerWait(requestId)
		void (async () => {
			try {
				const { nodeHash } = await resolveNodeHash(username)
				await fanoutFedFetch(username, action, buildPayload(requestId, nodeHash), canonicalTargets)
			}
			catch { /* pending wait 超时/cancel 负责 settle */ }
		})()
		return { done: wait.done, cancel: wait.cancel }
	})
}
