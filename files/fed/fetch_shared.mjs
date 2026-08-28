import { randomUUID } from 'node:crypto'

import { resolveNodeHash } from '../chunk/provider_registry.mjs'
import { fanoutFedFetch } from '../fetch_fanout.mjs'

/**
 * inflight + pending wait + fanout 共用骨架。
 * @template T
 * @param {{
 *   inflight: { acquire: (key: string, start: () => { done: Promise<T | null>, cancel: () => void }) => Promise<T | null> | null },
 *   inflightKey: string,
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
	inflightKey,
	username,
	action,
	registerWait,
	buildPayload,
	fanoutTargets,
}) {
	return inflight.acquire(inflightKey, () => {
		const requestId = randomUUID()
		const wait = registerWait(requestId)
		void (async () => {
			try {
				const { nodeHash } = await resolveNodeHash(username)
				await fanoutFedFetch(username, action, buildPayload(requestId, nodeHash), fanoutTargets)
			}
			catch { /* pending wait 超时/cancel 负责 settle */ }
		})()
		return { done: wait.done, cancel: wait.cancel }
	})
}
