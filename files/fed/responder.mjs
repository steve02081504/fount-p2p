import { subscribeWire } from '../../wire/subscribe.mjs'
import { handleIncomingChunkGet } from '../chunk/fetch.mjs'
import { resolvePendingChunkFetch } from '../chunk/pending.mjs'
import { handleIncomingManifestGet } from '../manifest/fetch.mjs'
import { resolvePendingManifestFetch } from '../manifest/pending.mjs'

/** @typedef {import('../../wire/adapter.mjs').WireAdapter} WireAdapter */

/**
 * node scope wire：注册 fed_chunk_* + fed_manifest_*。
 * @param {WireAdapter} wire action 表
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachNodeScopeFedResponder(wire) {
	return subscribeWire(wire, {
		/**
		 * @param {unknown} data chunk 请求载荷
		 * @param {string} peerId 对端 nodeHash
		 */
		fed_chunk_get(data, peerId) {
			void handleIncomingChunkGet(data, (resp, pid) => {
				try { wire.send('fed_chunk_data', resp, pid) }
				catch { /* disconnected */ }
			}, peerId)
		},
		/**
		 * @param {unknown} data chunk 响应载荷
		 */
		fed_chunk_data(data) { resolvePendingChunkFetch(data) },
		/**
		 * @param {unknown} data manifest 请求载荷
		 * @param {string} peerId 对端 nodeHash
		 */
		fed_manifest_get(data, peerId) {
			void handleIncomingManifestGet(data, (resp, pid) => {
				try { wire.send('fed_manifest_data', resp, pid) }
				catch { /* disconnected */ }
			}, peerId)
		},
		/**
		 * @param {unknown} data manifest 响应载荷
		 */
		fed_manifest_data(data) {
			void resolvePendingManifestFetch(data)
		},
	})
}
