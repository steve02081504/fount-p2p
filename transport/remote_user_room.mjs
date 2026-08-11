import { bumpLocalDataRevision } from '../node/local_data_revision.mjs'
import { registerFederationRoomProvider } from '../registries/room_provider.mjs'

import { closeLink, ensureLinkToNode, getLink } from './link_registry.mjs'
import { USER_ROOM_SCOPE } from './room_scopes.mjs'


/**
 * @typedef {{
 *   roomSlot: import('../registries/room_provider.mjs').FederationRoomSlot
 *   leave: () => void | Promise<void>
 * }} RemoteUserRoomSlot
 */

/** @type {Map<string, RemoteUserRoomSlot>} nodeHash → slot */
const slots = new Map()
/** @type {Map<string, Promise<RemoteUserRoomSlot>>} nodeHash → 进行中的 promise */
const inflights = new Map()

registerFederationRoomProvider('remote-user-room', () => {
	return [...slots.values()].map(s => s.roomSlot)
})

/**
 * 加入目标节点的用户房间（幂等）。
 * @param {string} targetNodeHash 目标节点 64 hex
 * @returns {Promise<RemoteUserRoomSlot>} 房间槽
 */
export async function ensureRemoteUserRoom(targetNodeHash) {
	const existing = slots.get(targetNodeHash)
	if (existing) return existing
	const inflight = inflights.get(targetNodeHash)
	if (inflight) return await inflight

	const task = (async () => {
		try {
			if (!await ensureLinkToNode(targetNodeHash))
				throw new Error(`p2p: ensureRemoteUserRoom link failed for ${targetNodeHash}`)

			/** @type {import('../registries/room_provider.mjs').FederationRoomSlot} */
			const roomSlot = {
				groupId: USER_ROOM_SCOPE,
				/**
				 * 返回远端用户房间 roster（链路存在时含目标节点）。
				 * @returns {Array<{ peerId: string, remoteNodeHash: string }>} roster 列表
				 */
				getRoster: () => getLink(targetNodeHash) ? [{ peerId: targetNodeHash, remoteNodeHash: targetNodeHash }] : [],
				/**
				 * 按 nodeHash 查找 peer id。
				 * @param {string} nh 目标节点 64 hex
				 * @returns {string | null} 对端 id；无链路时为 null
				 */
				getPeerIdByNodeHash: nh => getLink(nh) ? nh : null,
				/**
				 * 经 node scope 向远端 peer 发送 action。始终走当前规范链路（`getLink`），
				 * 因为 glare 双 PC 择一后最初返回的链路可能已被关闭，规范链在 registry 内。
				 * @param {string} peerId 目标 peer id
				 * @param {string} actionName action 名称
				 * @param {unknown} payload 载荷
				 * @returns {void}
				 */
				sendToPeer(peerId, actionName, payload) {
					void getLink(targetNodeHash)?.send({ scope: 'node', action: actionName, payload }).catch(() => { })
				},
			}

			const slot = {
				roomSlot,
				/**
				 * 关闭远端用户房间链路并释放槽位。
				 * @returns {Promise<void>} 关闭完成
				 */
				leave() {
					slots.delete(targetNodeHash)
					return closeLink(targetNodeHash, 'remote-user-room-release')
				},
			}
			slots.set(targetNodeHash, slot)
			bumpLocalDataRevision()
			return slot
		}
		finally {
			inflights.delete(targetNodeHash)
		}
	})()

	inflights.set(targetNodeHash, task)
	return await task
}
