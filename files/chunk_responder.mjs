import { resolvePendingChunkFetch } from '../federation/chunk_fetch_pending.mjs'
import { resolvePendingManifestFetch } from '../federation/manifest_fetch_pending.mjs'

import { handleIncomingChunkGet } from './chunk_fetch.mjs'
import { handleIncomingManifestGet } from './manifest_fetch.mjs'

/**
 * @param {string} username 副本用户名 用户名
 * @param {object} data 入站 fed_chunk_get
 * @param {string} peerId 对端 id
 * @param {(resp: object, peerId: string) => void} sendChunkData 发送 fed_chunk_data
 * @returns {Promise<void>}
 */
export async function handleFedChunkGetIngress(username, data, peerId, sendChunkData) {
	await handleIncomingChunkGet(username, data, sendChunkData, peerId)
}

/**
 * @param {object} data 入站 fed_chunk_data（含 requestId 时 resolve pending fetch）
 * @returns {void}
 */
export function handleFedChunkDataIngress(data) {
	resolvePendingChunkFetch(data)
}

/**
 * @param {string} username 副本用户名
 * @param {object} data 入站 fed_manifest_get
 * @param {string} peerId 对端 id
 * @param {(resp: object, peerId: string) => void} sendManifestData 发送 fed_manifest_data
 * @returns {Promise<void>}
 */
export async function handleFedManifestGetIngress(username, data, peerId, sendManifestData) {
	await handleIncomingManifestGet(username, data, sendManifestData, peerId)
}

/**
 * @param {object} data 入站 fed_manifest_data
 * @returns {Promise<void>}
 */
export async function handleFedManifestDataIngress(data) {
	await resolvePendingManifestFetch(data)
}

/**
 * node scope user-room wire：注册 fed_chunk_* + fed_manifest_*。
 * @param {string} username 副本用户名 用户名
 * @param {{ on: (name: string, handler: (payload: unknown, peerId: string) => void) => void, send: (name: string, payload: unknown, peerId: string | null) => void }} wire action 表
 * @returns {void}
 */
export function attachNodeScopeFedChunkResponder(username, wire) {
	wire.on('fed_chunk_get', (data, peerId) => {
		void handleFedChunkGetIngress(username, data, peerId, (resp, pid) => {
			try { wire.send('fed_chunk_data', resp, pid) }
			catch { /* disconnected */ }
		})
	})
	wire.on('fed_chunk_data', handleFedChunkDataIngress)
	wire.on('fed_manifest_get', (data, peerId) => {
		void handleFedManifestGetIngress(username, data, peerId, (resp, pid) => {
			try { wire.send('fed_manifest_data', resp, pid) }
			catch { /* disconnected */ }
		})
	})
	wire.on('fed_manifest_data', data => {
		void handleFedManifestDataIngress(data)
	})
}

/**
 * Trystero room：注册带 requestId 的 fed_chunk_* + fed_manifest_*（TrustGraph 全局 miss）。
 * @param {string} username 用户
 * @param {object} room Trystero room
 * @param {{ enqueue: (prio: number, cleanup: () => void) => void }} [fedOut] 出站队列
 * @param {(roomKey: string, action: string, rtcLimits: object) => boolean} [guardGet] RTC 负载守卫
 * @param {object} [rtcLimits] RTC 限额
 * @param {string} [roomKey] 房间键
 * @returns {void}
 */
export function attachTrustGraphFedChunkResponder(username, room, fedOut, guardGet, rtcLimits = {}, roomKey = '') {
	const [sendChunkData, getChunkData] = room.makeAction('fed_chunk_data')
	const [, getChunkGet] = room.makeAction('fed_chunk_get')
	const [sendManifestData, getManifestData] = room.makeAction('fed_manifest_data')
	const [, getManifestGet] = room.makeAction('fed_manifest_get')

	getChunkGet((data, peerId) => {
		if (guardGet && !guardGet(roomKey, 'fed_chunk_get', rtcLimits)) return
		void (async () => {
			if (!data || typeof data !== 'object') return
			if (!String(data.requestId || '')) return
			await handleFedChunkGetIngress(username, data, peerId, (resp, pid) => {
				/**
				 *
				 */
				const send = () => {
					try { sendChunkData(resp, pid) }
					catch (error) {
						console.warn('federation: trust-graph chunk response failed', error)
					}
				}
				if (fedOut) fedOut.enqueue(6, send)
				else send()
			})
		})().catch(error => console.warn('federation: trust-graph chunk handler failed', error))
	})

	getChunkData(data => {
		if (!data || typeof data !== 'object' || !data.requestId) return
		handleFedChunkDataIngress(data)
	})

	getManifestGet((data, peerId) => {
		if (guardGet && !guardGet(roomKey, 'fed_manifest_get', rtcLimits)) return
		void (async () => {
			if (!data || typeof data !== 'object') return
			if (!String(data.requestId || '')) return
			await handleFedManifestGetIngress(username, data, peerId, (resp, pid) => {
				/**
				 *
				 */
				const send = () => {
					try { sendManifestData(resp, pid) }
					catch (error) {
						console.warn('federation: trust-graph manifest response failed', error)
					}
				}
				if (fedOut) fedOut.enqueue(6, send)
				else send()
			})
		})().catch(error => console.warn('federation: trust-graph manifest handler failed', error))
	})

	getManifestData(data => {
		if (!data || typeof data !== 'object' || !data.requestId) return
		void handleFedManifestDataIngress(data)
	})
}
