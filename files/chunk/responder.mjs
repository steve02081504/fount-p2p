import { handleIncomingManifestGet } from '../manifest/fetch.mjs'
import { resolvePendingManifestFetch } from '../manifest/pending.mjs'

import { handleIncomingChunkGet } from './fetch.mjs'
import { resolvePendingChunkFetch } from './pending.mjs'

/**
 * 群联邦 / TrustGraph 路径：响应带 requestId 的 fed_chunk_get。
 * @param {object} data 入站 fed_chunk_get
 * @param {string} peerId 对端 id
 * @param {(resp: object, peerId: string) => void} sendChunkData 发送 fed_chunk_data
 * @returns {Promise<void>}
 */
export async function handleFedChunkGetIngress(data, peerId, sendChunkData) {
	await handleIncomingChunkGet(data, sendChunkData, peerId)
}

/**
 * @param {object} data 入站 fed_chunk_data（含 requestId 时 resolve pending fetch）
 * @returns {boolean} 是否命中 pending
 */
export function handleFedChunkDataIngress(data) {
	return resolvePendingChunkFetch(data)
}

/**
 * @param {object} data 入站 fed_manifest_get
 * @param {string} peerId 对端 id
 * @param {(resp: object, peerId: string) => void} sendManifestData 发送 fed_manifest_data
 * @returns {Promise<void>}
 */
export async function handleFedManifestGetIngress(data, peerId, sendManifestData) {
	await handleIncomingManifestGet(data, sendManifestData, peerId)
}

/**
 * @param {object} data 入站 fed_manifest_data
 * @returns {Promise<boolean>} 是否命中 pending
 */
export function handleFedManifestDataIngress(data) {
	return resolvePendingManifestFetch(data)
}

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
		void handleFedChunkGetIngress(data, peerId, sendChunk)
	})

	getChunkData(data => {
		if (!data?.requestId) return
		handleFedChunkDataIngress(data)
	})

	getManifestGet((data, peerId) => {
		if (guardGet && !guardGet(roomKey, 'fed_manifest_get', rtcLimits)) return
		if (!data?.requestId) return
		void handleFedManifestGetIngress(data, peerId, sendManifest)
	})

	getManifestData(data => {
		if (!data?.requestId) return
		handleFedManifestDataIngress(data)
	})
}
