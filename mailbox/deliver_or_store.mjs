import { normalizeHex64 } from '../core/hexIds.mjs'
import { getNodeTransportSettings, getNodeHash } from '../node/identity.mjs'
import { activeLinkRoster, deliverToUserRoomPeers } from '../transport/user_room.mjs'
import { DEFAULT_TRUST_GRAPH_OWNER, requireTrustGraphProvider } from '../trust_graph/registry.mjs'

import { allowMailboxRelayForTier } from './importance.mjs'
import { takeIncomingMailboxPutSlot } from './rate.mjs'
import { resolveMailboxRoutingForPeerCount } from './settings.mjs'
import {
	isDeliverableMailboxRecord,
	isMailboxRecordWithinSizeLimit,
	mailboxEnvelopeId,
	mailboxTierFromHop,
	normalizeMailboxHop,
	relayHopAfterWireIngress,
	storeMailboxRecord,
	getMailboxRecords,
} from './store.mjs'

/**
 * @param {string} username 副本用户名
 * @param {string} peerId Trystero 对端 id
 * @returns {Promise<string | null>} 已验证的 remote nodeHash
 */
async function resolveRemoteNodeHashForPeer(username, peerId) {
	void username
	if (!peerId) return null
	const entry = activeLinkRoster().find(row => row.peerId === peerId)
	const remote = entry?.remoteNodeHash?.trim().toLowerCase()
	return remote || null
}

/**
 * @param {object} record 入站 record
 * @returns {Promise<number>} 本节点应存储的 hop
 */
async function resolveRelayHopForIngress(record) {
	let id
	try {
		id = mailboxEnvelopeId(record.envelope)
	}
	catch {
		return relayHopAfterWireIngress(record.hop)
	}
	const existing = (await getMailboxRecords([id]))[0]
	return relayHopAfterWireIngress(record.hop, existing?.hop)
}

/**
 * @param {string} username 副本用户名
 * @returns {Promise<{ maxHop: number, relayFanoutTrusted: number, relayFanoutNormal: number, wantFanout: number, batterySaver: boolean }>} 按在线 peer 数缩放的路由
 */
async function resolveRouting(username) {
	void username
	const { batterySaver, mailbox } = getNodeTransportSettings()
	const peerCount = activeLinkRoster().length
	return resolveMailboxRoutingForPeerCount(peerCount, mailbox, batterySaver)
}

/**
 * @param {string} username 副本用户名（trust graph 投递上下文）
 * @param {object} options 投递选项
 * @returns {Promise<{ stored: boolean, delivered: boolean, relayed: number }>} 存转结果
 */
export async function deliverOrStoreMailboxPut(username, options) {
	const routing = await resolveRouting(username)
	const toPubKeyHash = normalizeHex64(options.toPubKeyHash)
	if (!toPubKeyHash) return { stored: false, delivered: false, relayed: 0 }
	const hop = normalizeMailboxHop(options.hop)
	if (hop >= routing.maxHop) return { stored: false, delivered: false, relayed: 0 }
	const tier = mailboxTierFromHop(hop)
	const nodeHash = getNodeHash()
	const record = {
		...options.record,
		toPubKeyHash,
		hop,
		tier,
		fromNodeHash: options.record?.fromNodeHash || nodeHash,
	}
	const stored = await storeMailboxRecord(record)
	const toNodeHash = options.toNodeHash?.trim().toLowerCase()
	const delivered = toNodeHash && isMailboxRecordWithinSizeLimit(record)
		? await requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER).sendToNode(username, toNodeHash, 'mailbox_put', { nodeHash, record })
		: false

	let relayed = 0
	const relayFanout = tier === 'trusted' ? routing.relayFanoutTrusted : routing.relayFanoutNormal
	if (stored && hop < routing.maxHop && allowMailboxRelayForTier(tier))
		relayed = await deliverToUserRoomPeers(username, 'mailbox_put', { record }, null, relayFanout)

	return { stored, delivered, relayed }
}

/**
 * @param {string} username 副本用户名
 * @param {string} toPubKeyHash 收件人
 * @param {object} record 待发 record
 * @param {string} [toNodeHash] 已知在线节点时直投
 * @returns {Promise<{ stored: boolean, delivered: boolean, relayed: number }>} 存转结果
 */
export async function publishMailboxRecord(username, toPubKeyHash, record, toNodeHash = '') {
	return deliverOrStoreMailboxPut(username, {
		toPubKeyHash,
		toNodeHash: toNodeHash || undefined,
		record: { ...record, toPubKeyHash },
		hop: 0,
	})
}

/**
 * @param {{ replicaUsername?: string }} wireContext 入站上下文
 * @param {object} put 入站 mailbox_put
 * @param {string} [peerId] Trystero 对端 id（有则校验 nodeHash 绑定）
 * @returns {Promise<void>}
 */
export async function ingestMailboxPut(wireContext, put, peerId = '') {
	const { record } = put
	if (!record?.envelope || !record?.toPubKeyHash) return
	const fromNode = normalizeHex64(put.nodeHash)
	if (!fromNode || !takeIncomingMailboxPutSlot(fromNode)) return
	const username = String(wireContext.replicaUsername || '').trim()
	if (!username) return
	if (peerId) {
		const remote = await resolveRemoteNodeHashForPeer(username, peerId)
		if (!remote || remote !== fromNode) return
	}
	const routing = await resolveRouting(username)
	const relayHop = await resolveRelayHopForIngress(record)
	if (relayHop >= routing.maxHop) return
	await deliverOrStoreMailboxPut(username, {
		toPubKeyHash: record.toPubKeyHash,
		record: {
			...record,
			fromNodeHash: fromNode,
		},
		hop: relayHop,
	})
}

/**
 * @param {object} want mailbox_want 载荷
 * @param {(payload: unknown, peerId: string) => void} sendGive mailbox_give 发送回调
 * @param {string} peerId 请求方 peer
 * @returns {Promise<void>}
 */
export async function respondMailboxWant(want, sendGive, peerId) {
	const { getMailboxRecords, takeMailboxForRecipient } = await import('./store.mjs')
	const recipient = normalizeHex64(want.toPubKeyHash)
	if (!recipient) return
	const ids = want.ids || []
	const rows = (ids.length
		? await getMailboxRecords(ids)
		: await takeMailboxForRecipient(recipient)
	).filter(row => row.toPubKeyHash === recipient && isDeliverableMailboxRecord(row))
	if (!rows.length) return
	sendGive({ toPubKeyHash: recipient, records: rows.slice(0, 32) }, peerId)
}

/**
 * @param {{ replicaUsername?: string }} wireContext 入站上下文
 * @param {object} give mailbox_give 载荷
 * @returns {Promise<number>} 投递给消费者的记录数
 */
export async function ingestMailboxGive(wireContext, give) {
	const records = (give.records || []).filter(isDeliverableMailboxRecord)
	if (!records.length) return 0
	const username = String(wireContext.replicaUsername || '').trim()
	if (!username) return 0
	const { dispatchMailboxRecordsToConsumers } = await import('./consumer_registry.mjs')
	const { deleteMailboxRecords } = await import('./store.mjs')
	const delivered = await dispatchMailboxRecordsToConsumers(username, records)
	if (delivered.length) await deleteMailboxRecords(delivered)
	return delivered.length
}

/**
 * @param {string} username 副本用户名
 * @param {string} toPubKeyHash 本机收件人 pubKeyHash
 * @returns {Promise<void>}
 */
export async function requestMailboxFromNetwork(username, toPubKeyHash) {
	const routing = await resolveRouting(username)
	const { listMailboxIdsForRecipient } = await import('./store.mjs')
	const recipient = normalizeHex64(toPubKeyHash)
	if (!recipient) return
	await deliverToUserRoomPeers(username, 'mailbox_want', {
		toPubKeyHash: recipient,
		ids: (await listMailboxIdsForRecipient(recipient)).slice(0, 64),
	}, null, routing.wantFanout)
}
