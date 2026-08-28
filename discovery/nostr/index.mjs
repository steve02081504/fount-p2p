import { randomBytes } from 'node:crypto'

import { schnorr } from '@noble/curves/secp256k1.js'

import { bytesToBase64, bytesToHex, hexToBytes } from '../../core/bytes_codec.mjs'
import { isHex64 } from '../../core/hexIds.mjs'
import { sha256Hex } from '../../crypto/crypto.mjs'
import { getNodeTransportSettings } from '../../node/identity.mjs'
import { getSignalingRuntimeConfig } from '../../node/instance.mjs'
import { nodeDebug, shortHash } from '../../node/log.mjs'
import { noteAdvertPeerHints } from '../advert_peer_hints.mjs'
import { ingestEncryptedAdvert } from '../adverts.mjs'
import {
	encryptSignalPacket,
	groupRendezvousKey,
	networkRendezvousKey,
	nodeRendezvousKey,
} from '../internal/signal_crypto.mjs'
import { noteDiscoveryPeerClue } from '../peer_clue.mjs'

import { createNostrCensus } from './census.mjs'
import {
	DEFAULT_RELAY_URLS,
	getListenRelays,
	getPeerRoute,
	getPoolByUrl,
	isRelayDestinationAllowed,
	probeRelay,
	resolveRelayConnectTarget,
	resolveTrustedRelayConnectTarget,
	setPeerRoute,
	upsertRelay,
} from './relays.mjs'
import { routePublishEvent } from './selection.mjs'
import { dedupeRelayUrls, publishViaSharedRelay, subscribeNostrKind } from './session.mjs'


/** Nostr network advert 事件 kind（addressable，可存储）。 */
export const NOSTR_ADVERT_KIND = 30787
/** Nostr signal 事件 kind（ephemeral，实时转发）。 */
export const NOSTR_SIGNAL_KIND = 20787

/** 打广告用的话题 tag（hashtag，NIP-01），公开可被搜索聚合。 */
const NOSTR_TOPIC_TAG = ['t', 'fount']

const ADVERT_TTL_MS = 10 * 60_000

/** @type {Map<string, number>} 网络域 nodeHash → lastSeenAt */
const visibleByHash = new Map()
/** @type {Map<string, Map<string, number>>} roomSecret → (nodeHash → lastSeenAt) */
const visibleByGroup = new Map()

/**
 * @param {Map<string, number>} pool 可见池
 * @param {number} now 当前时间
 * @param {number} ttlMs TTL
 * @returns {string[]} 未过期 nodeHash
 */
function listPoolHashes(pool, now, ttlMs) {
	/** @type {string[]} */
	const out = []
	for (const [hash, seenAt] of pool)
		if (now - seenAt <= ttlMs) out.push(hash)
		else pool.delete(hash)
	return out
}

/**
 * 写入网络域可见池（非群）。
 * @param {string} nodeHash 节点 hash
 * @param {number} [now=Date.now()] 当前时间
 * @returns {void}
 */
export function noteNostrVisibleNode(nodeHash, now = Date.now()) {
	const hash = isHex64(nodeHash)
	if (!hash) return
	visibleByHash.set(hash, now)
}

/**
 * 写入群域可见池（与网络域隔离）。
 * @param {string} roomSecret 房间密钥
 * @param {string} nodeHash 节点 hash
 * @param {number} [now=Date.now()] 当前时间
 * @returns {void}
 */
export function noteNostrGroupVisibleNode(roomSecret, nodeHash, now = Date.now()) {
	const hash = isHex64(nodeHash)
	if (!roomSecret || !hash) return
	let pool = visibleByGroup.get(roomSecret)
	if (!pool) {
		pool = new Map()
		visibleByGroup.set(roomSecret, pool)
	}
	pool.set(hash, now)
}

/**
 * @param {number} [now=Date.now()] 当前时间
 * @param {number} [ttlMs=ADVERT_TTL_MS] TTL
 * @returns {string[]} 网络域可见 nodeHash
 */
export function listNostrVisibleNodeHashes(now = Date.now(), ttlMs = ADVERT_TTL_MS) {
	return listPoolHashes(visibleByHash, now, ttlMs)
}

/**
 * @param {string} roomSecret 房间密钥
 * @param {number} [now=Date.now()] 当前时间
 * @param {number} [ttlMs=ADVERT_TTL_MS] TTL
 * @returns {string[]} 该群可见 nodeHash
 */
export function listNostrGroupVisibleNodeHashes(roomSecret, now = Date.now(), ttlMs = ADVERT_TTL_MS) {
	const pool = visibleByGroup.get(roomSecret)
	if (!pool) return []
	const out = listPoolHashes(pool, now, ttlMs)
	if (!pool.size) visibleByGroup.delete(roomSecret)
	return out
}

/**
 * 捕获对端 advert 中的 relay 字段：listen 存 peerRoutes.listenRelays、pool 存 peerPool；
 * 本机池中未见 url 以 source='peer' upsert 并后台 probe。
 * 仅吸收/探测允许的公网地址（或本机显式配置/引导集中的中继），阻止远端 advert 驱动对 loopback/私网地址的 probe 与入池。
 * @param {string} verifiedNodeHash 验签 nodeHash
 * @param {string[]} listenRelays 规范化 listen
 * @param {Array<{ url: string, rtt: number }>} relayPool 规范化 pool
 * @returns {Promise<void>}
 */
async function capturePeerRelayFields(verifiedNodeHash, listenRelays, relayPool) {
	if (!isHex64(verifiedNodeHash)) return
	setPeerRoute(verifiedNodeHash, {
		listenRelays,
		peerPool: relayPool,
	})
	for (const item of relayPool) {
		if (getPoolByUrl().has(item.url)) continue
		if (!await isRelayDestinationAllowed(item.url)) continue
		upsertRelay({ url: item.url, rttMs: item.rtt, source: 'peer' })
		void probeRelay(item.url).catch(() => { })
	}
}

/**
 * 解密并验签后写入 Nostr 可见池；捕获对端 relay 字段到 peerRoutes；伪造 body.nodeHash 无效。
 * @param {string} rendezvousKey rendezvous 键
 * @param {Uint8Array} bytes 加密 advert
 * @param {{ roomSecret?: string, skipNodeHash?: string, meta?: object }} [options] 群池 / 本机回环过滤 / meta
 * @returns {Promise<string | null>} 验签通过的 nodeHash
 */
export async function acceptNostrAdvert(rendezvousKey, bytes, options = {}) {
	const ingested = await ingestEncryptedAdvert(rendezvousKey, bytes)
	if (!ingested) return null
	const hash = ingested.verifiedNodeHash
	if (isHex64(options.skipNodeHash) === hash) return hash
	let firstSeen = true
	if (options.roomSecret) {
		firstSeen = !visibleByGroup.get(options.roomSecret)?.has(hash)
		noteNostrGroupVisibleNode(options.roomSecret, hash)
	}
	else {
		firstSeen = !visibleByHash.has(hash)
		noteNostrVisibleNode(hash)
	}
	if (firstSeen) {
		noteDiscoveryPeerClue(hash)
		nodeDebug('p2p:nostr peer visible', { peer: shortHash(hash), group: !!options.roomSecret })
	}
	await capturePeerRelayFields(hash, ingested.listenRelays, ingested.relayPool)
	noteAdvertPeerHints(hash, ingested.body, options.meta || {})
	return hash
}

/** @returns {void} 测试用 */
export function clearNostrVisibleNodes() {
	visibleByHash.clear()
	visibleByGroup.clear()
}

/**
 * 当前可用 nostr 中继：用户显式配置 `channels.nostr.relay` 优先；否则返回 listenRelays 工作子集。
 * @returns {string[]} relay URL 列表
 */
export function resolveNostrRelayUrls() {
	const relay = getSignalingRuntimeConfig().channels?.nostr?.relay
	if (Array.isArray(relay) && relay.length) return dedupeRelayUrls(relay)
	const configRelay = getNodeTransportSettings().relayUrls
	return configRelay.length ? dedupeRelayUrls(configRelay) : getListenRelays().map(entry => entry.url)
}

/**
 * @param {number} kind 事件 kind
 * @param {string[][]} tags 事件标签
 * @param {string} content 事件内容
 * @param {Uint8Array} secretKey Schnorr 私钥
 * @returns {Promise<object>} 已签名的 Nostr 事件对象
 */
async function signNostrEvent(kind, tags, content, secretKey) {
	const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
	const created_at = Math.floor(Date.now() / 1000)
	const id = sha256Hex(JSON.stringify([0, pubkey, created_at, kind, tags, content]))
	return { id, pubkey, created_at, kind, tags, content, sig: bytesToHex(await schnorr.sign(hexToBytes(id), secretKey)) }
}

/**
 * 全量发布到给定 relay（任一成功即返回）。
 * @param {string[]} relayUrls 中继 URL 列表
 * @param {object} event 待发布事件
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<void>}
 */
async function publishEvent(relayUrls, event, signal) {
	const urls = dedupeRelayUrls(relayUrls)
	if (!urls.length) throw new Error('nostr: no relay')
	let published = false
	let lastError = null
	await Promise.allSettled(urls.map(async relayUrl => {
		try {
			const connectTarget = await resolveTrustedRelayConnectTarget(relayUrl)
			if (!connectTarget) return
			if (await publishViaSharedRelay(relayUrl, event, signal, connectTarget)) published = true
		}
		catch (error) {
			lastError = error
		}
	}))
	if (!published) throw lastError || new Error('nostr: no relay accepted publish')
}

/**
 * 创建 Nostr discovery provider（list+connect；topic 仅内部）。
 * @param {{ relayUrls?: string[] | null, getRelayUrls?: () => string[] | null | undefined, localNodeHash?: string }} [options] 中继配置与本机 hash
 * @returns {import('../index.mjs').DiscoveryProvider} Nostr discovery provider
 */
export function createNostrDiscoveryProvider(options = {}) {
	const hasExplicitRelay = options.relayUrls != null || !!options.getRelayUrls
	/** @returns {string[]} 去重后的中继 URL 列表 */
	const resolveRelayUrls = () => {
		if (options.getRelayUrls) return dedupeRelayUrls(options.getRelayUrls() ?? DEFAULT_RELAY_URLS)
		return options.relayUrls == null ? resolveNostrRelayUrls() : dedupeRelayUrls(options.relayUrls)
	}
	const secretKey = randomBytes(32)
	/** @type {string | null} */
	let selfNodeHash = isHex64(options.localNodeHash)
	const NETWORK_SUB_KEY = 'network'
	/**
	 * @typedef {{ stop: () => void, held: boolean, listeners: Set<(bytes: Uint8Array, meta: object) => void> }} AdvertSubEntry
	 */
	/** @type {Map<string, AdvertSubEntry>} */
	const advertSubs = new Map()
	/** @type {Map<string, () => void>} */
	const nodeSignalSubs = new Map()

	/**
	 * @param {string | undefined | null} nodeHash 本机 hash
	 * @returns {void}
	 */
	function noteSelfNodeHash(nodeHash) {
		const hash = isHex64(nodeHash)
		if (hash) selfNodeHash = hash
	}

	/**
	 * @param {string} key 订阅键
	 * @param {AdvertSubEntry} entry 条目
	 * @returns {void}
	 */
	function releaseAdvertEntryIfIdle(key, entry) {
		if (entry.held || entry.listeners.size) return
		try { entry.stop() } catch { /* ignore */ }
		advertSubs.delete(key)
	}

	/**
	 * pool/connect 永久 hold；watch listener 归零且无 hold 时拆 REQ。
	 * @param {string} key 订阅键
	 * @param {{ rendezvousKey: string, roomSecret?: string }} bind advert 绑定
	 * @param {(bytes: Uint8Array, meta: object) => void} [listener] 额外监听
	 * @returns {() => void} 取消 listener；无 listener 时 no-op（hold 至 dispose）
	 */
	function ensureAdvertSubscription(key, bind, listener) {
		let entry = advertSubs.get(key)
		if (!entry) {
			/** @type {AdvertSubEntry} */
			const created = {
				/**
				 * @returns {void}
				 */
				stop: () => { }, held: false, listeners: new Set()
			}
			created.stop = subscribeNostrKind(resolveRelayUrls(), {
				kind: NOSTR_ADVERT_KIND,
				rendezvousKey: bind.rendezvousKey,
				tagX: 'advert',
				addressable: true,
				resolveConnectTarget: resolveTrustedRelayConnectTarget,
				/**
				 * @param {Uint8Array} bytes 加密 advert 载荷
				 * @param {object} meta relay 元数据
				 * @returns {Promise<void>}
				 */
				async onPayload(bytes, meta) {
					await acceptNostrAdvert(bind.rendezvousKey, bytes, {
						roomSecret: bind.roomSecret,
						skipNodeHash: selfNodeHash || undefined,
						meta,
					})
					for (const fn of created.listeners)
						try { fn(bytes, meta) } catch { /* ignore */ }
				},
			})
			entry = created
			advertSubs.set(key, entry)
		}
		if (!listener) {
			entry.held = true
			return () => { }
		}
		entry.listeners.add(listener)
		return () => {
			entry.listeners.delete(listener)
			releaseAdvertEntryIfIdle(key, entry)
		}
	}

	/**
	 * @returns {() => void} no-op（network hold 至 dispose）
	 */
	function ensureNetworkAdvertSubscription() {
		return ensureAdvertSubscription(NETWORK_SUB_KEY, {
			rendezvousKey: networkRendezvousKey(),
		})
	}

	/**
	 * @param {string} roomSecret 房间密钥
	 * @param {(bytes: Uint8Array, meta: object) => void} [listener] 额外 advert 监听
	 * @returns {() => void} 取消 listener
	 */
	function ensureGroupSubscription(roomSecret, listener) {
		return ensureAdvertSubscription('group:' + roomSecret, {
			rendezvousKey: groupRendezvousKey(roomSecret),
			roomSecret,
		}, listener)
	}

	/**
	 * @param {string} nodeHash 目标
	 * @param {(bytes: Uint8Array, meta: object) => void} [listener] 额外 advert 监听
	 * @returns {() => void} 取消 listener
	 */
	function ensureNodeAdvertSubscription(nodeHash, listener) {
		const hash = isHex64(nodeHash)
		if (!hash) return () => { }
		return ensureAdvertSubscription('node:' + hash, {
			rendezvousKey: nodeRendezvousKey(hash),
		}, listener)
	}

	/** @type {Array<() => void>} */
	const extraSubs = []

	/**
	 * connectToNode 额外订阅对端历史/声称的中继以加速汇聚（adhoc，dispose 时释放）。
	 * 仅订阅允许连接的公网中继，拒绝解析到私网/本机未配置的目的地。
	 * @param {string} nodeHash 目标节点
	 * @returns {Promise<void>}
	 */
	async function ensurePeerRelaySubscriptions(nodeHash) {
		const hash = isHex64(nodeHash)
		if (!hash) return
		const route = getPeerRoute(hash)
		const extra = dedupeRelayUrls([
			...route?.lastGoodNostrRelays || [],
			...route?.listenRelays || [],
		]).filter(url => !resolveRelayUrls().includes(url))
		if (!extra.length) return
		const entries = await Promise.all(extra.map(async url => ({ url, allowed: await isRelayDestinationAllowed(url) })))
		const targets = entries.filter(entry => entry.allowed).map(entry => entry.url)
		if (!targets.length) return
		const rendezvousKey = nodeRendezvousKey(hash)
		extraSubs.push(subscribeNostrKind(targets, {
			kind: NOSTR_ADVERT_KIND,
			rendezvousKey,
			tagX: 'advert',
			addressable: true,
			resolveConnectTarget: resolveRelayConnectTarget,
			/**
			 * 处理订阅收到的 advert 字节。
			 * @param {Uint8Array} bytes advert 字节
			 * @returns {Promise<string | null>} 接受后的节点 hash，拒绝时为 null
			 */
			onPayload: bytes => acceptNostrAdvert(rendezvousKey, bytes, {
				skipNodeHash: selfNodeHash || undefined,
			}),
		}))
	}

	return {
		id: 'nostr',
		priority: 100,
		caps: { canDiscover: true, canSignal: true, canRelay: false },
		/**
		 * @param {{ limit?: number, roomSecret?: string }} [options] 扫描选项
		 * @returns {Promise<string[]>} 可见 nodeHash；带 roomSecret 时仅返回该群池
		 */
		async listVisibleNodeHashes(options = {}) {
			const limit = Math.max(1, Number(options.limit) || 64)
			if (options.roomSecret) {
				ensureGroupSubscription(options.roomSecret)
				return listNostrGroupVisibleNodeHashes(options.roomSecret)
					.filter(hash => hash !== selfNodeHash)
					.slice(0, limit)
			}
			ensureNetworkAdvertSubscription()
			return listNostrVisibleNodeHashes()
				.filter(hash => hash !== selfNodeHash)
				.slice(0, limit)
		},
		/**
		 * 挂上对该节点的内部 advert 订阅（建链由 registry dialer / ensureLinkToNode 完成）。
		 * @param {string} nodeHash 目标
		 * @returns {Promise<boolean>} 是否已准备
		 */
		async connectToNode(nodeHash) {
			const hash = isHex64(nodeHash)
			if (!hash) return false
			ensureNodeAdvertSubscription(hash)
			await ensurePeerRelaySubscriptions(hash)
			return true
		},
		/**
		 * @param {() => Promise<object | null>} getBeacon 本机 advert body 工厂
		 * @returns {Promise<() => void>} 停止函数
		 */
		async startPresence(getBeacon) {
			const rendezvousKey = networkRendezvousKey()
			const abortController = new AbortController()
			ensureNetworkAdvertSubscription()
			/**
			 * @returns {Promise<void>}
			 */
			const publish = async () => {
				if (abortController.signal.aborted) return
				const beacon = await getBeacon?.()
				if (!beacon?.nodeHash) return
				noteSelfNodeHash(beacon.nodeHash)
				const event = await signNostrEvent(
					NOSTR_ADVERT_KIND,
					[NOSTR_TOPIC_TAG, ['t', rendezvousKey], ['x', 'advert'], ['d', rendezvousKey]],
					bytesToBase64(encryptSignalPacket(rendezvousKey, { type: 'advert', body: beacon.advertBody || beacon.body || beacon })),
					secretKey,
				)
				await publishEvent(resolveRelayUrls(), event, abortController.signal)
				nodeDebug('p2p:nostr presence published', { self: shortHash(beacon.nodeHash) })
			}
			void publish().catch(error => {
				nodeDebug('p2p:nostr presence publish fail', { err: String(error?.message || error) })
			})
			const timer = setInterval(() => {
				void publish().catch(error => {
					nodeDebug('p2p:nostr presence publish fail', { err: String(error?.message || error) })
				})
			}, 5 * 60_000)
			timer.unref?.()
			// census（人口统计）：由 features.census 开关驱动，worker 内部每周期自检。
			const census = createNostrCensus({
				resolveRelayUrls,
				publishEvent,
				/**
				 * @param {number} kind 事件 kind
				 * @param {string[][]} tags 事件标签
				 * @param {string} content 事件内容
				 * @returns {Promise<object>} 已签名事件
				 */
				signEvent: (kind, tags, content) => signNostrEvent(kind, tags, content, secretKey),
				subscribeNostrKind,
			})
			census.start()
			return () => {
				abortController.abort()
				clearInterval(timer)
				census.stop()
			}
		},
		/**
		 * @param {string} toNodeHash 目标 nodeHash
		 * @param {Uint8Array} bytes 加密信令
		 * @returns {Promise<void>}
		 */
		async sendNodeSignal(toNodeHash, bytes) {
			const hash = isHex64(toNodeHash)
			if (!hash) throw new Error('nostr: invalid nodeHash')
			const rendezvousKey = nodeRendezvousKey(hash)
			const event = await signNostrEvent(
				NOSTR_SIGNAL_KIND,
				[NOSTR_TOPIC_TAG, ['t', rendezvousKey], ['x', 'signal'], ['p', hash]],
				bytesToBase64(bytes),
				secretKey,
			)
			// 显式 relay 覆盖（测试/用户 pin）时直接全量发布；否则走握手路由。
			if (hasExplicitRelay) {
				await publishEvent(resolveRelayUrls(), event)
				return
			}
			await routePublishEvent(hash, event)
		},
		/**
		 * @param {string} localNodeHash 本机 nodeHash
		 * @param {(bytes: Uint8Array) => void} onSignal 信令回调
		 * @returns {Promise<() => void>} 取消函数
		 */
		async listenNodeSignals(localNodeHash, onSignal) {
			const hash = isHex64(localNodeHash)
			if (!hash) throw new Error('nostr: invalid nodeHash')
			noteSelfNodeHash(hash)
			const rendezvousKey = nodeRendezvousKey(hash)
			const existing = nodeSignalSubs.get(hash)
			if (existing) existing()
			nodeDebug('p2p:nostr signal listen', { self: shortHash(hash), relays: resolveRelayUrls().length })
			const stop = subscribeNostrKind(resolveRelayUrls(), {
				kind: NOSTR_SIGNAL_KIND,
				rendezvousKey,
				tagX: 'signal',
				resolveConnectTarget: resolveTrustedRelayConnectTarget,
				onPayload: onSignal,
			})
			nodeSignalSubs.set(hash, stop)
			return () => {
				stop()
				nodeSignalSubs.delete(hash)
			}
		},
		/**
		 * @param {string} nodeHash 目标 nodeHash
		 * @param {(bytes: Uint8Array, meta: object) => void} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消函数
		 */
		async watchNodeAdvert(nodeHash, onAdvert) {
			const hash = isHex64(nodeHash)
			if (!hash) throw new Error('nostr: invalid nodeHash')
			return ensureNodeAdvertSubscription(hash, onAdvert)
		},
		/**
		 * @param {string} roomSecret 房间密钥
		 * @param {() => Promise<object | null>} getBeacon advert 工厂
		 * @returns {Promise<() => void>} 停止群 presence 广播
		 */
		async startGroupPresence(roomSecret, getBeacon) {
			const rendezvousKey = groupRendezvousKey(roomSecret)
			const abortController = new AbortController()
			ensureGroupSubscription(roomSecret)
			/**
			 * @returns {Promise<void>}
			 */
			const publish = async () => {
				if (abortController.signal.aborted) return
				const beacon = await getBeacon?.()
				if (!beacon?.nodeHash) return
				noteSelfNodeHash(beacon.nodeHash)
				const event = await signNostrEvent(
					NOSTR_ADVERT_KIND,
					[NOSTR_TOPIC_TAG, ['t', rendezvousKey], ['x', 'advert'], ['d', rendezvousKey]],
					bytesToBase64(encryptSignalPacket(rendezvousKey, { type: 'advert', body: beacon.advertBody || beacon.body || beacon })),
					secretKey,
				)
				await publishEvent(resolveRelayUrls(), event, abortController.signal)
			}
			void publish().catch(() => { })
			const timer = setInterval(() => { void publish().catch(() => { }) }, 5 * 60_000)
			timer.unref?.()
			return () => {
				abortController.abort()
				clearInterval(timer)
			}
		},
		/**
		 * @param {string} roomSecret 房间密钥
		 * @param {(bytes: Uint8Array, meta: object) => void} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消群 advert 监听
		 */
		async watchGroupAdverts(roomSecret, onAdvert) {
			return ensureGroupSubscription(roomSecret, onAdvert)
		},
		/**
		 * 供 advert 解析路径写入可见 hash。
		 * @param {string} nodeHash 节点 hash
		 * @param {{ roomSecret?: string }} [options] 带 roomSecret 时写入群池
		 * @returns {void}
		 */
		noteVisibleNode(nodeHash, options = {}) {
			if (options.roomSecret) noteNostrGroupVisibleNode(options.roomSecret, nodeHash)
			else noteNostrVisibleNode(nodeHash)
		},
		/** @returns {void} 停止全部内部订阅 */
		dispose() {
			for (const entry of advertSubs.values())
				try { entry.stop() } catch { /* ignore */ }
			advertSubs.clear()
			for (const stop of nodeSignalSubs.values())
				try { stop() } catch { /* ignore */ }
			nodeSignalSubs.clear()
			for (const stop of extraSubs)
				try { stop() } catch { /* ignore */ }
			extraSubs.length = 0
		},
	}
}
