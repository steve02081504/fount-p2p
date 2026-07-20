import { advertiseTopic, subscribeTopic } from '../discovery/index.mjs'
import { ingestSignedAdvert } from '../transport/advert_ingest.mjs'
import { getLinkRegistry } from '../transport/link_registry.mjs'
import {
	encryptSignalPacket,
	groupRendezvousTopic,
} from '../transport/signal_crypto.mjs'
import { emitSafe } from '../utils/emit_safe.mjs'

/**
 * 在指定 scope 与 roomSecret 下创建 link 层房间（discovery + registry 转发）。
 * @param {object} options 房间选项
 * @param {string} options.scope link registry scope（如 `group:{id}`）
 * @param {string} options.roomSecret 房间 rendezvous 密钥
 * @param {(nodeHash: string) => boolean} [options.allowNode] 是否允许与某 nodeHash 通信
 * @returns {{ start: () => Promise<void>, leave: () => Promise<void>, makeAction: (name: string) => [(payload: unknown, peerId?: string | string[] | null) => Promise<void>, (handler: (payload: unknown, peerId: string) => void) => void], onPeerJoin: (callback: (peerId: string) => void) => () => void, onPeerLeave: (callback: (peerId: string) => void) => () => void, getPeers: () => Record<string, true> }} 房间句柄
 */
export function createScopedLinkRoom(options) {
	const registry = getLinkRegistry()
	const { scope } = options
	const topic = groupRendezvousTopic(options.roomSecret)
	const allowNode = options.allowNode ?? (() => true)
	/** @type {Set<string>} */
	const discoveredPeers = new Set()
	/** @type {Set<string>} */
	const announcedPeers = new Set()
	/** @type {Set<(peerId: string) => void>} */
	const joinListeners = new Set()
	/** @type {Set<(peerId: string) => void>} */
	const leaveListeners = new Set()
	/** @type {Set<() => void>} */
	const cleanups = new Set()
	/** @type {Map<string, { handler: ((payload: unknown, peerId: string) => void) | null, backlog: Array<{ payload: unknown, peerId: string }> }>} */
	const actionEntries = new Map()

	/**
	 * @returns {string[]} 当前已连接且通过 allowNode 过滤的 peer nodeHash 列表
	 */
	function activePeerIds() {
		return [...discoveredPeers].filter(nodeHash => allowNode(nodeHash) && registry.getLink(nodeHash))
	}

	/**
	 * @param {string} peerId 节点 hash
	 * @returns {void}
	 */
	function notePeerJoin(peerId) {
		if (!peerId || announcedPeers.has(peerId)) return
		announcedPeers.add(peerId)
		emitSafe(joinListeners, peerId)
	}

	/**
	 * @param {string} peerId 节点 hash
	 * @returns {void}
	 */
	function notePeerLeave(peerId) {
		if (!peerId || !announcedPeers.has(peerId)) return
		announcedPeers.delete(peerId)
		emitSafe(leaveListeners, peerId)
	}

	/**
	 * @param {string} name action 名称
	 * @returns {{ handler: ((payload: unknown, peerId: string) => void) | null, backlog: Array<{ payload: unknown, peerId: string }> }} action 槽（含待处理 backlog）
	 */
	function getActionEntry(name) {
		if (!actionEntries.has(name))
			actionEntries.set(name, { handler: null, backlog: [] })
		return actionEntries.get(name)
	}

	return {
		/**
		 * @returns {Promise<void>}
		 */
		async start() {
			await registry.ensureRuntime()
			cleanups.add(registry.subscribeScope(scope, (senderNodeHash, envelope) => {
				if (!allowNode(senderNodeHash)) return
				const entry = actionEntries.get(envelope.action)
				if (!entry) return
				if (entry.handler) entry.handler(envelope.payload, senderNodeHash)
				else entry.backlog.push({ payload: envelope.payload, peerId: senderNodeHash })
			}))
			cleanups.add(registry.onLinkUp(nodeHash => {
				if (!discoveredPeers.has(nodeHash) || !allowNode(nodeHash)) return
				notePeerJoin(nodeHash)
			}))
			cleanups.add(registry.onLinkDown(nodeHash => {
				if (!discoveredPeers.has(nodeHash)) return
				notePeerLeave(nodeHash)
			}))
			cleanups.add(await subscribeTopic(topic, async (bytes, meta) => {
				const ingested = await ingestSignedAdvert(topic, bytes, meta)
				if (!ingested || !allowNode(ingested.verifiedNodeHash)) return
				discoveredPeers.add(ingested.verifiedNodeHash)
				await registry.ensureLinkToNode(ingested.verifiedNodeHash).catch(() => null)
				if (registry.getLink(ingested.verifiedNodeHash)) notePeerJoin(ingested.verifiedNodeHash)
			}))
			cleanups.add(await advertiseTopic(topic, encryptSignalPacket(topic, {
				type: 'advert',
				body: await registry.buildLocalAdvert(topic),
			})))
			for (const peerId of activePeerIds())
				notePeerJoin(peerId)
		},
		/**
		 * @returns {Promise<void>}
		 */
		async leave() {
			for (const cleanup of cleanups)
				try { cleanup() } catch { /* ignore */ }
			cleanups.clear()
			for (const peerId of [...announcedPeers])
				notePeerLeave(peerId)
		},
		/**
		 * @param {string} name action 名称
		 * @returns {[(payload: unknown, peerId?: string | string[] | null) => Promise<void>, (handler: (payload: unknown, peerId: string) => void) => void]} [send, onReceive] 发送与订阅元组
		 */
		makeAction(name) {
			return [
				async (payload, peerId = null) => {
					if (Array.isArray(peerId)) {
						await Promise.all(peerId.map(targetPeerId =>
							registry.sendToNodeLink(targetPeerId, { scope, action: name, payload })))
						return
					}
					if (peerId)
						await registry.sendToNodeLink(peerId, { scope, action: name, payload })
					else
						await Promise.all(activePeerIds().map(targetPeerId =>
							registry.sendToNodeLink(targetPeerId, { scope, action: name, payload })))
				},
				handler => {
					const entry = getActionEntry(name)
					entry.handler = handler
					for (const pending of entry.backlog.splice(0))
						handler(pending.payload, pending.peerId)
				},
			]
		},
		/**
		 * @param {(peerId: string) => void} callback 新 peer 上线回调
		 * @returns {() => void} 取消订阅
		 */
		onPeerJoin(callback) {
			joinListeners.add(callback)
			for (const peerId of activePeerIds())
				announcedPeers.add(peerId)
			for (const peerId of announcedPeers)
				try { callback(peerId) } catch { /* ignore */ }
			return () => joinListeners.delete(callback)
		},
		/**
		 * @param {(peerId: string) => void} callback peer 离线回调
		 * @returns {() => void} 取消订阅
		 */
		onPeerLeave(callback) {
			leaveListeners.add(callback)
			return () => leaveListeners.delete(callback)
		},
		/**
		 * @returns {Record<string, true>} 当前活跃 peer 的 nodeHash 集合
		 */
		getPeers() {
			return Object.fromEntries(activePeerIds().map(peerId => [peerId, true]))
		},
	}
}
