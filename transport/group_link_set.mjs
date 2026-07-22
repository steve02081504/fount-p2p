import { listVisibleNodeHashes, startGroupPresence, watchVerifiedGroupAdverts } from '../discovery/index.mjs'
import { loadPeerPoolView } from '../node/network.mjs'
import { loadReputation } from '../node/reputation_store.mjs'
import { emitSafe } from '../utils/emit_safe.mjs'

import { applyAdvertPeerHints } from './advert_ingest.mjs'
import { getLinkRegistry } from './link_registry.mjs'
import { resolveFederationPoolLimits, selectLinkTargetsFromMembers } from './peer_pool.mjs'
import { loadTransportTunables } from './tunables.mjs'

/**
 * 创建基于 link registry 的群组联邦房间（唯一内核；scoped_link 为其薄预设）。
 * @param {object} options 选项
 * @param {string} options.groupId 群 ID
 * @param {string} [options.scope] scope 前缀（默认 `group:${groupId}`）
 * @param {string} [options.roomSecret] 群 discovery / advert 密钥
 * @param {string[]} [options.members] 初始成员 nodeHash
 * @param {(nodeHash: string) => boolean} [options.allowNode] 入站成员过滤
 * @param {boolean} [options.dialAll=false] true 时拨号全部成员，否则按 mesh 策略
 * @param {boolean} [options.autoconnect=true] start 时是否自动拨号
 * @param {object} [options.groupSettings] 群设置透传
 * @param {object} [options.registry] link registry（默认进程单例）
 * @returns {object} 群组 link set 接口
 */
export function createGroupLinkSet(options) {
	const registry = options.registry ?? getLinkRegistry()
	let autoconnectEnabled = false
	const startWithAutoconnect = options.autoconnect !== false
	const dialAll = options.dialAll === true
	const allowNode = options.allowNode ?? (() => true)
	const { groupId } = options
	const scope = options.scope ?? `group:${groupId}`
	const roomSecret = options.roomSecret
	const members = new Set(options.members || [])
	const selfNodeHash = registry.localIdentity.nodeHash
	const groupSettings = options.groupSettings ?? {}
	const initialAnchors = new Set(members)
	/** @type {ReturnType<typeof setTimeout> | null} */
	let dialTimer = null
	/** @type {ReturnType<typeof setInterval> | null} */
	let scanTimer = null
	/** @type {Set<Function>} */
	const cleanups = new Set()
	/** @type {Set<Function>} */
	const envelopeListeners = new Set()
	/** @type {Set<(peerId: string) => void>} */
	const peerJoinListeners = new Set()
	/** @type {Set<(peerId: string) => void>} */
	const peerLeaveListeners = new Set()
	/** @type {Set<string>} */
	const announcedPeers = new Set()
	/** @type {Map<string, { handler: ((payload: unknown, peerId: string) => void) | null, backlog: Array<{ payload: unknown, peerId: string }> }>} */
	const actionEntries = new Map()
	let active = true
	let started = false

	/**
	 * @param {() => void} cleanup 清理函数
	 * @returns {void}
	 */
	function registerCleanup(cleanup) {
		if (typeof cleanup !== 'function') return
		cleanups.add(cleanup)
	}

	/**
	 * @param {string} peerId peer id
	 * @returns {void}
	 */
	function notePeerJoin(peerId) {
		if (!peerId || !allowNode(peerId) || announcedPeers.has(peerId)) return
		announcedPeers.add(peerId)
		emitSafe(peerJoinListeners, peerId)
	}

	/**
	 * @param {string} peerId peer id
	 * @returns {void}
	 */
	function notePeerLeave(peerId) {
		if (!peerId || !announcedPeers.has(peerId)) return
		announcedPeers.delete(peerId)
		emitSafe(peerLeaveListeners, peerId)
	}

	/**
	 * @param {string} nodeHash 候选节点
	 * @returns {void}
	 */
	function notePeerCandidate(nodeHash) {
		if (!nodeHash || nodeHash === selfNodeHash || !allowNode(nodeHash)) return
		if (members.has(nodeHash)) {
			if (registry.getLink(nodeHash)) notePeerJoin(nodeHash)
			return
		}
		members.add(nodeHash)
		registry.registerScopeInterest(scope, [...members])
		if (registry.getLink(nodeHash)) notePeerJoin(nodeHash)
		scheduleDial()
	}

	/**
	 * @returns {void}
	 */
	function selectAndDial() {
		if (!autoconnectEnabled || !active) return
		const targets = dialAll
			? [...members].filter(nodeHash => nodeHash !== selfNodeHash && allowNode(nodeHash))
			: selectLinkTargetsFromMembers({
				members,
				selfNodeHash,
				rep: loadReputation(),
				peers: loadPeerPoolView(groupId),
				limits: resolveFederationPoolLimits(groupSettings),
				anchors: initialAnchors,
			}).filter(allowNode)
		for (const nodeHash of targets)
			if (nodeHash !== selfNodeHash && !registry.getLink(nodeHash))
				void registry.ensureLinkToNode(nodeHash).catch(() => null)
	}

	/**
	 * @returns {void}
	 */
	function scheduleDial() {
		if (!autoconnectEnabled || !active || dialTimer) return
		dialTimer = setTimeout(() => { dialTimer = null; selectAndDial() }, 200)
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function scanVisibleMembers() {
		const tunables = loadTransportTunables()
		const limit = Math.max(8, Number(tunables.groupMemberScanLimit ?? tunables.meshScanLimit) || 64)
		for (const hash of await listVisibleNodeHashes({ roomSecret, limit }))
			notePeerCandidate(hash)
	}

	/**
	 * @param {string} name action 名
	 * @returns {object} action 表项
	 */
	function getActionEntry(name) {
		if (!actionEntries.has(name))
			actionEntries.set(name, { handler: null, backlog: [] })
		return actionEntries.get(name)
	}

	/**
	 * @returns {Array<{ peerId: string, remoteNodeHash: string }>} 当前在线 roster
	 */
	function activeRoster() {
		return [...members]
			.filter(nodeHash => nodeHash !== selfNodeHash && allowNode(nodeHash) && registry.getLink(nodeHash))
			.map(nodeHash => ({ peerId: nodeHash, remoteNodeHash: nodeHash }))
	}

	/**
	 *
	 */
	function startAutoconnect() {
		autoconnectEnabled = true
		selectAndDial()
	}

	/**
	 *
	 */
	function stopAutoconnect() {
		autoconnectEnabled = false
		if (dialTimer) { clearTimeout(dialTimer); dialTimer = null }
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function start() {
		if (started) {
			if (startWithAutoconnect) startAutoconnect()
			return
		}
		started = true
		active = true
		if (typeof registry.ensureRuntime === 'function')
			await registry.ensureRuntime()
		registry.registerScopeInterest(scope, [...members])
		registerCleanup(registry.subscribeScope(scope, (senderNodeHash, envelope) => {
			if (!allowNode(senderNodeHash)) return
			notePeerCandidate(senderNodeHash)
			const entry = actionEntries.get(envelope.action)
			if (entry)
				if (entry.handler) entry.handler(envelope.payload, senderNodeHash)
				else entry.backlog.push({ payload: envelope.payload, peerId: senderNodeHash })

			for (const listener of envelopeListeners)
				listener(senderNodeHash, envelope)
		}))
		registerCleanup(registry.onLinkUp(nodeHash => {
			if (!members.has(nodeHash) || nodeHash === selfNodeHash || !allowNode(nodeHash)) return
			notePeerJoin(nodeHash)
		}))
		registerCleanup(registry.onLinkDown(nodeHash => {
			if (!members.has(nodeHash) || nodeHash === selfNodeHash) return
			notePeerLeave(nodeHash)
		}))

		registerCleanup(await watchVerifiedGroupAdverts(roomSecret, async (verifiedNodeHash, body, meta) => {
			if (verifiedNodeHash === selfNodeHash) return
			if (!allowNode(verifiedNodeHash)) return
			applyAdvertPeerHints(verifiedNodeHash, body, meta)
			notePeerCandidate(verifiedNodeHash)
		}))

		registerCleanup(await startGroupPresence(roomSecret, async () => ({
			nodeHash: selfNodeHash,
			advertBody: await registry.buildLocalAdvert({ roomSecret }),
		})))

		await scanVisibleMembers()
		const scanMs = Math.max(5_000, Number(loadTransportTunables().groupMemberScanIntervalMs) || 30_000)
		scanTimer = setInterval(() => { void scanVisibleMembers().catch(() => { }) }, scanMs)
		registerCleanup(() => {
			if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
		})

		if (startWithAutoconnect) startAutoconnect()
		for (const { peerId } of activeRoster())
			notePeerJoin(peerId)
	}

	return {
		groupId,
		scope,
		start,
		startAutoconnect,
		stopAutoconnect,
		/**
		 * @returns {Promise<void>}
		 */
		async leave() {
			if (!active && !started) return
			active = false
			started = false
			stopAutoconnect()
			registry.releaseScopeInterest(scope)
			for (const cleanup of cleanups)
				try { cleanup() } catch { /* ignore */ }
			cleanups.clear()
		},
		getRoster: activeRoster,
		/**
		 * @param {string} nodeHash 远端节点 hash
		 * @returns {string | null} 已建链时返回 peerId，否则 null
		 */
		getPeerIdByNodeHash(nodeHash) {
			return registry.getLink(nodeHash) ? nodeHash : null
		},
		/**
		 * @param {string} peerId 目标 peer
		 * @param {string} actionName scope action 名
		 * @param {unknown} payload 载荷
		 * @returns {Promise<boolean>} 发送是否成功
		 */
		async sendToPeer(peerId, actionName, payload) {
			if (!allowNode(peerId)) return false
			return await registry.sendToNodeLink(peerId, { scope, action: actionName, payload })
		},
		/**
		 * @param {string} actionName action 名
		 * @param {(payload: unknown, peerId: string) => void} handler 回调
		 * @returns {() => void} 取消订阅
		 */
		onAction(actionName, handler) {
			const entry = getActionEntry(actionName)
			entry.handler = handler
			for (const pending of entry.backlog.splice(0))
				handler(pending.payload, pending.peerId)
			return () => {
				if (entry.handler === handler) entry.handler = null
			}
		},
		/**
		 * @param {string} actionName action 名
		 * @param {unknown} payload 载荷
		 * @param {string | null} [peerId] 单播目标；省略则广播 roster
		 * @returns {Promise<number>} 成功发送数
		 */
		async send(actionName, payload, peerId = null) {
			if (peerId) return await this.sendToPeer(peerId, actionName, payload) ? 1 : 0
			let sent = 0
			for (const { peerId: targetPeerId } of activeRoster())
				if (await registry.sendToNodeLink(targetPeerId, { scope, action: actionName, payload })) sent++
			return sent
		},
		/**
		 * @param {(senderNodeHash: string, envelope: object) => void} listener scope envelope 回调
		 * @returns {() => void} 取消订阅
		 */
		onEnvelope(listener) {
			envelopeListeners.add(listener)
			return () => envelopeListeners.delete(listener)
		},
		/**
		 * @param {(peerId: string) => void} listener peer 加入回调
		 * @returns {() => void} 取消订阅
		 */
		onPeerJoin(listener) {
			peerJoinListeners.add(listener)
			for (const { peerId } of activeRoster())
				if (peerId) announcedPeers.add(peerId)
			for (const peerId of announcedPeers)
				try { listener(peerId) } catch { /* ignore */ }
			return () => peerJoinListeners.delete(listener)
		},
		/**
		 * @param {(peerId: string) => void} listener peer 离开回调
		 * @returns {() => void} 取消订阅
		 */
		onPeerLeave(listener) {
			peerLeaveListeners.add(listener)
			return () => peerLeaveListeners.delete(listener)
		},
		/**
		 * @returns {Record<string, true>} 当前在线 peer 表
		 */
		getPeers() {
			return Object.fromEntries(activeRoster().map(({ peerId }) => [peerId, true]))
		},
		/**
		 * @param {string} name action 名
		 * @returns {[Function, Function]} [send, onHandler] 元组：发送函数与注册 handler 函数
		 */
		makeAction(name) {
			return [
				async (payload, peerId = null) => {
					if (Array.isArray(peerId)) {
						await Promise.all(peerId.map(targetPeerId => this.sendToPeer(targetPeerId, name, payload)))
						return
					}
					await this.send(name, payload, peerId)
				},
				handler => {
					const entry = getActionEntry(name)
					entry.handler = handler
					for (const pending of entry.backlog.splice(0))
						handler(pending.payload, pending.peerId)
				},
			]
		},
		registerCleanup,
		/**
		 * @returns {boolean} 群 link set 是否仍活跃
		 */
		isActive() { return active },
	}
}
