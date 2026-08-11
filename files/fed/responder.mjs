import { handleIncomingChunkGet } from '../chunk/fetch.mjs'
import { resolvePendingChunkFetch } from '../chunk/pending.mjs'
import { handleIncomingManifestGet } from '../manifest/fetch.mjs'
import { resolvePendingManifestFetch } from '../manifest/pending.mjs'

/**
 * @param {(resp: object, peerId: string) => void} sendData 发送 data 响应
 * @param {{ enqueue: (prio: number, cleanup: () => void) => void }} [fedOut] 出站限速队列
 * @returns {(resp: object, peerId: string) => void} 可入队的发送包装
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
 * node scope user-room wire：注册 fed_chunk_* + fed_manifest_*。
 * @param {{ on: (name: string, handler: (payload: unknown, peerId: string) => void) => (() => void) | void, send: (name: string, payload: unknown, peerId: string | null) => void }} wire action 表
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopeFedResponder(wire) {
	const offs = [
		wire.on('fed_chunk_get', (data, peerId) => {
			void handleIncomingChunkGet(data, (resp, pid) => {
				try { wire.send('fed_chunk_data', resp, pid) }
				catch { /* disconnected */ }
			}, peerId)
		}),
		wire.on('fed_chunk_data', data => { resolvePendingChunkFetch(data) }),
		wire.on('fed_manifest_get', (data, peerId) => {
			void handleIncomingManifestGet(data, (resp, pid) => {
				try { wire.send('fed_manifest_data', resp, pid) }
				catch { /* disconnected */ }
			}, peerId)
		}),
		wire.on('fed_manifest_data', data => {
			void resolvePendingManifestFetch(data)
		}),
	]
	return () => {
		for (const off of offs)
			try { off?.() } catch { /* ignore */ }
	}
}

/**
 * Trystero room：注册带 requestId 的 fed_chunk_* + fed_manifest_*（TrustGraph 全局 miss）。
 * @param {object} room Trystero room
 * @param {{ enqueue: (prio: number, cleanup: () => void) => void }} [fedOut] 出站队列
 * @param {(roomKey: string, action: string, rtcLimits: object) => boolean} [guardGet] RTC 负载守卫
 * @param {object} [rtcLimits] RTC 限额
 * @param {string} [roomKey] 房间键
 * @returns {void}
 */
export function attachTrustGraphFedResponder(room, fedOut, guardGet, rtcLimits = {}, roomKey = '') {
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
		void handleIncomingChunkGet(data, sendChunk, peerId).catch(() => { })
	})

	getChunkData(data => {
		if (!data?.requestId) return
		resolvePendingChunkFetch(data)
	})

	getManifestGet((data, peerId) => {
		if (guardGet && !guardGet(roomKey, 'fed_manifest_get', rtcLimits)) return
		if (!data?.requestId) return
		void handleIncomingManifestGet(data, sendManifest, peerId).catch(() => { })
	})

	getManifestData(data => {
		if (!data?.requestId) return
		void resolvePendingManifestFetch(data)
	})
}
