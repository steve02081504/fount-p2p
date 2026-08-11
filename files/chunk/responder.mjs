import { handleIncomingManifestGet } from '../manifest/fetch.mjs'
import { resolvePendingManifestFetch } from '../manifest/pending.mjs'

import { handleIncomingChunkGet } from './fetch.mjs'
import { resolvePendingChunkFetch } from './pending.mjs'

/**
 * @param {(resp: object, peerId: string) => void} sendData 发送
 * @param {{ enqueue: (prio: number, cleanup: () => void) => void }} [fedOut] 出站限速队列
 * @returns {(resp: object, peerId: string) => void} 可入队的发送
 */
function wrapSend(sendData, fedOut) {
	if (!fedOut) return sendData
	return (resp, peerId) => {
		fedOut.enqueue(6, () => {
			try { sendData(resp, peerId) }
			catch { /* peer gone */ }
		})
	}
}

/**
 * Trystero room：注册带 requestId 的 fed_chunk_* + fed_manifest_*（TrustGraph / 群全局 miss）。
 * @param {object} room Trystero room
 * @param {{ enqueue: (prio: number, cleanup: () => void) => void }} [fedOut] 出站队列
 * @param {(roomKey: string, action: string, rtcLimits: object) => boolean} [guardGet] RTC 负载守卫
 * @param {object} [rtcLimits] RTC 限额
 * @param {string} [roomKey] 房间键
 * @returns {void}
 */
export function attachTrustGraphFedChunkResponder(room, fedOut, guardGet, rtcLimits = {}, roomKey = '') {
	const [sendChunkData, getChunkData] = room.makeAction('fed_chunk_data')
	const [, getChunkGet] = room.makeAction('fed_chunk_get')
	const [sendManifestData, getManifestData] = room.makeAction('fed_manifest_data')
	const [, getManifestGet] = room.makeAction('fed_manifest_get')

	const sendChunk = wrapSend((resp, peerId) => {
		try { sendChunkData(resp, peerId) }
		catch { /* peer gone */ }
	}, fedOut)
	const sendManifest = wrapSend((resp, peerId) => {
		try { sendManifestData(resp, peerId) }
		catch { /* peer gone */ }
	}, fedOut)

	getChunkGet((data, peerId) => {
		if (guardGet && !guardGet(roomKey, 'fed_chunk_get', rtcLimits)) return
		if (!data?.requestId) return
		void handleIncomingChunkGet(data, sendChunk, peerId)
	})

	getChunkData(data => {
		if (!data?.requestId) return
		resolvePendingChunkFetch(data)
	})

	getManifestGet((data, peerId) => {
		if (guardGet && !guardGet(roomKey, 'fed_manifest_get', rtcLimits)) return
		if (!data?.requestId) return
		void handleIncomingManifestGet(data, sendManifest, peerId)
	})

	getManifestData(data => {
		if (!data?.requestId) return
		resolvePendingManifestFetch(data)
	})
}
