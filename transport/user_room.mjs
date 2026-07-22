import { createHash } from 'node:crypto'

import { ensureNodeDefaults, getNodeHash } from '../node/identity.mjs'
import { registerFederationRoomProvider } from '../registries/room_provider.mjs'
import { shuffleInPlace } from '../utils/shuffle.mjs'

import { getLinkRegistry, listLinks, sendToNodeLink } from './link_registry.mjs'
import {
	attachUserRoomDefaultWires,
	ensureNodeScope,
} from './node_scope.mjs'
import { USER_ROOM_SCOPE } from './room_scopes.mjs'

/**
 * 经 node scope 向对端发 action。
 * @param {string} peerId 对端 nodeHash
 * @param {string} action 动作名
 * @param {unknown} payload 载荷
 * @returns {Promise<boolean>} 是否发出
 */
const sendNodeAction = (peerId, action, payload) =>
	sendToNodeLink(peerId, { scope: 'node', action, payload })

/** @type {Promise<UserRoomSlot> | null} */
let userRoomInflight = null

/** @type {UserRoomSlot | null} */
let userRoomSlot = null

/** @type {(() => void) | null} */
let userRoomDefaultWiresDispose = null

/**
 * @returns {UserRoomSlot | null} 已创建的用户房间槽，未 ensure 时为 null
 */
export function getUserRoomSlot() {
	return userRoomSlot
}

/**
 * 返回当前所有活跃链路的 roster。
 * @returns {Array<{ peerId: string, remoteNodeHash: string }>} 活跃链路列表
 */
export function activeLinkRoster() {
	return listLinks().map(({ nodeHash }) => ({ peerId: nodeHash, remoteNodeHash: nodeHash }))
}

/**
 * @typedef {{
 *   roomId: string
 *   roomSecret: string
 *   room: object | null
 *   sendToPeer: (peerId: string, actionName: string, payload: unknown) => void
 *   getRoster: () => Array<{ peerId: string, remoteNodeHash: string | undefined }>
 *   getPeerIdByNodeHash: (nodeHash: string) => string | null
 * }} UserRoomSlot
 */

registerFederationRoomProvider('user-room', () => {
	const slot = getUserRoomSlot()
	if (!slot) return []
	return [{
		groupId: USER_ROOM_SCOPE,
		/**
		 * @returns {Array<{ peerId: string, remoteNodeHash: string | undefined }>} 当前 roster
		 */
		getRoster: () => slot.getRoster(),
		/**
		 * @param {string} nodeHash - 远端节点 hash
		 * @returns {string | null} 已连接时返回 peerId，否则 null
		 */
		getPeerIdByNodeHash: nodeHash => slot.getPeerIdByNodeHash(nodeHash),
		/**
		 * @param {string} peerId - 目标 peer
		 * @param {string} actionName - node scope action 名
		 * @param {unknown} payload - 载荷
		 * @returns {void}
		 */
		sendToPeer: (peerId, actionName, payload) => slot.sendToPeer(peerId, actionName, payload),
	}]
})

/**
 * @returns {{ appId: string, password: string, roomId: string, nodeHash: string }} user room rendezvous 凭据
 */
export function resolveUserRoomCredentials() {
	const nodeHash = getNodeHash()
	const password = createHash('sha256').update(`fount-user-room:${nodeHash}`).digest('hex')
	return {
		appId: 'fount-user-fed',
		password,
		roomId: `fount-node-${nodeHash}`,
		nodeHash,
	}
}

/**
 * 用户房间槽 + runtime；默认不挂业务 wire（用 `attachUserRoomDefaultWires` / `attachDefaultWires: true`）。
 * @param {{ replicaUsername?: string, attachDefaultWires?: boolean }} [options] - 副本用户名与是否挂载默认 wire
 * @returns {Promise<UserRoomSlot>} 用户房间槽
 */
export async function ensureUserRoom(options = {}) {
	const { attachDefaultWires = false } = options
	if (options.replicaUsername != null)
		ensureNodeScope({ replicaUsername: options.replicaUsername })
	if (userRoomSlot) {
		if (attachDefaultWires && !userRoomDefaultWiresDispose)
			userRoomDefaultWiresDispose = attachUserRoomDefaultWires({ replicaUsername: options.replicaUsername })
		return userRoomSlot
	}
	if (userRoomInflight) return await userRoomInflight

	userRoomInflight = (async () => {
		ensureNodeDefaults()
		await getLinkRegistry().ensureRuntime()
		ensureNodeScope({ replicaUsername: options.replicaUsername })
		if (attachDefaultWires && !userRoomDefaultWiresDispose)
			userRoomDefaultWiresDispose = attachUserRoomDefaultWires({ replicaUsername: options.replicaUsername })
		const creds = resolveUserRoomCredentials()
		userRoomSlot = {
			roomId: creds.roomId,
			roomSecret: creds.password,
			room: null,
			/**
			 * @param {string} peerId - 目标 peer
			 * @param {string} actionName - node scope action 名
			 * @param {unknown} payload - 载荷
			 * @returns {void}
			 */
			sendToPeer(peerId, actionName, payload) {
				void sendNodeAction(peerId, actionName, payload).catch(() => { })
			},
			/**
			 * @returns {Array<{ peerId: string, remoteNodeHash: string }>} 当前活跃链路 roster
			 */
			getRoster: () => activeLinkRoster(),
			/**
			 * @param {string} nodeHash - 远端节点 hash
			 * @returns {string | null} 已连接时返回 peerId，否则 null
			 */
			getPeerIdByNodeHash(nodeHash) {
				return getLinkRegistry().getLink(nodeHash) ? nodeHash : null
			},
		}
		return userRoomSlot
	})()

	try {
		return await userRoomInflight
	}
	finally {
		userRoomInflight = null
	}
}

/**
 * @param {string} username 副本用户名
 * @param {string} actionName 节点 scope action
 * @param {unknown} payload 载荷
 * @param {string | null} [exceptPeerId] 跳过的 peer
 * @param {number} [limit] 最多转发 peer 数
 * @returns {Promise<number>} 成功转发的 peer 数
 */
export async function deliverToUserRoomPeers(username, actionName, payload, exceptPeerId = null, limit) {
	void username
	const { USER_ROOM_PEER_FANOUT_DEFAULT } = await import('../wire/part_common.mjs')
	const fanoutLimit = limit ?? USER_ROOM_PEER_FANOUT_DEFAULT
	const body = { ...payload, nodeHash: getNodeHash() }
	let sent = 0
	const peers = shuffleInPlace(activeLinkRoster()
		.filter(({ peerId }) => peerId && peerId !== exceptPeerId))
	for (const { peerId } of peers)
		try {
			if (await sendNodeAction(peerId, actionName, body))
				sent++
			if (sent >= fanoutLimit) break
		}
		catch { /* disconnected */ }

	return sent
}

/** 再导出：node-scope 订阅与默认 wires（见 `node_scope.mjs`）。 */
export { attachUserRoomDefaultWires, ensureNodeScope } from './node_scope.mjs'
