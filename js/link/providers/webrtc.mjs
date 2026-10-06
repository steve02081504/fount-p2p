import { toBytes } from '../../core/bytes_codec.mjs'
import { getSignalingRuntimeConfig } from '../../node/instance.mjs'
import { nodeDebug } from '../../node/log.mjs'
import { ms } from '../../utils/duration.mjs'
import { createLruMap } from '../../utils/lru.mjs'
import {
	CHANNEL_BULK,
	CHANNEL_CONTROL,
	CHANNEL_LOW_THRESHOLD_BYTES,
	configureBufferedAmountLowThreshold,
	createChannelSendQueues,
	onBufferedAmountLow,
} from '../channel_mux.mjs'
import { asLinkHandle, createLinkPipe } from '../pipe.mjs'
import { iceLocalHostnameLadder } from '../../node/signaling_config.mjs'
import { loadNodeRtcPolyfill, waitForChannelState } from '../rtc/index.mjs'
import { extractDtlsFingerprint } from '../sdp_fingerprint.mjs'

import { LINK_LEVEL_WEBRTC } from './levels.mjs'

/** 收到候选后多久无新候选就视为 gathering 收齐（polyfill 不推 complete 时的兜底）。 */
export const ICE_CANDIDATE_SETTLE_MS = 300
/** gathering 状态轮询间隔。 */
const ICE_GATHERING_POLL_MS = 50
/** 一个候选都没收到时，等这么久就放行让 DTLS/数据通道自行判成败。 */
export const ICE_GATHERING_STALL_MS = ms('3s')

/**
 * 无 trickle ICE 时等本地候选收齐。
 *
 * 不把 `iceGatheringState === 'complete'` 当作唯一完成条件，也不靠比较 SDP 字符串：服务端 polyfill
 * （node-datachannel）把候选通过 `icecandidate` 事件派发，`localDescription.sdp` 里并不含候选行，
 * 而 gathering 状态在「全部 relay 超时」等情况下会长期停在 'gathering'（fount-p2p#37 次要观察）。
 * 所以完成判据是：状态 complete、收到过候选且一段时间内再无新候选、或一个候选都没收到时直接放行。
 * 最后一种走 [ICE_GATHERING_STALL_MS]，让 DTLS/数据通道自己判成败，而不是在握手超时后才硬失败。
 * @param {{ iceGatheringState: () => string, candidateCount?: () => number, handshakeTimeoutMs: number, settleMs?: number, stallMs?: number, onStall?: (elapsedMs: number) => void }} options 观测、超时与窗口配置
 * @returns {Promise<'complete' | 'stable' | 'stalled'>} 结束原因
 * @throws {Error} 超过 handshakeTimeoutMs 仍未收齐
 */
export async function collectIceGathering(options) {
	const { iceGatheringState, candidateCount, handshakeTimeoutMs, onStall } = options
	const settleMs = options.settleMs ?? ICE_CANDIDATE_SETTLE_MS
	const stallMs = options.stallMs ?? ICE_GATHERING_STALL_MS
	const startedAt = Date.now()
	const deadline = startedAt + handshakeTimeoutMs
	const failIfOverdue = () => {
		if (Date.now() >= deadline)
			throw new Error(`p2p: ice gathering incomplete after ${handshakeTimeoutMs}ms`)
	}
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
	while (true) {
		if (iceGatheringState() === 'complete') return 'complete'
		await sleep(ICE_GATHERING_POLL_MS)
		if (iceGatheringState() === 'complete') return 'complete'
		const candidates = candidateCount?.() ?? 0
		// 一个候选都没收到，再等也不会变：放行让 DTLS/数据通道自己判成败。
		if (!candidates) {
			const elapsedMs = Date.now() - startedAt
			if (elapsedMs >= stallMs) {
				onStall?.(elapsedMs)
				return 'stalled'
			}
			failIfOverdue()
			continue
		}
		// 有候选了：等「再无新候选」的窗口过去；窗口内又来候选就重新计时。
		await sleep(settleMs)
		if (iceGatheringState() === 'complete') return 'complete'
		if ((candidateCount?.() ?? 0) === candidates) return 'stable'
		failIfOverdue()
	}
}

/**
 * @param {unknown} error 原始错误
 * @returns {string} 短 reason
 */
function formatErrorReason(error) {
	return String(error?.message ?? error ?? 'unknown-error').replace(/\s+/g, ' ').slice(0, 240)
}

let cachedAvailable = null

/**
 * 探测 WebRTC（node-datachannel 或纯 JS fallback）是否可用。
 * @returns {Promise<boolean>} 可用为 true
 */
export async function canUseWebRtcLink() {
	if (cachedAvailable !== null) return cachedAvailable
	try {
		const rtc = await loadNodeRtcPolyfill()
		cachedAvailable = true
		nodeDebug('p2p:webrtc backend', { backend: rtc.backend })
	}
	catch (error) {
		cachedAvailable = false
		const reason = formatErrorReason(error)
		nodeDebug('p2p:webrtc unavailable', {
			err: typeof globalThis.Deno !== 'undefined'
				? `${reason} | deno: see docs/runtime.md (node-datachannel scripts only)`
				: reason,
		})
	}
	return cachedAvailable
}

/**
 * 建立 WebRTC link（双 DataChannel + discovery 信令）。
 *
 * ICE 本地主机名策略按观测结果逐级升级（见 [iceLocalHostnameLadder]）：一级 gathering 后候选集为空
 * 就换更宽松的一级重建 peer connection 重发 offer（**全新一次建链尝试**，不是重新协商已有连接，
 * 所以 DTLS 指纹绑定语义不变）。接受方按 offer 里的 `rung` 在同级重建并回 answer，自身不升级，
 * 故收敛有界。
 * @param {object} options link 配置
 * @param {string | null} [options.nodeHash] 期望的对端 nodeHash
 * @param {boolean} options.initiator 是否为连接发起方
 * @param {{ send: (message: unknown) => void | Promise<void>, onRemote: (handler: (message: unknown) => void) => (() => void) | void }} options.signal 信令收发接口
 * @param {RTCConfiguration['iceServers']} [options.iceServers] ICE 服务器列表
 * @param {number} [options.heartbeatMs] 心跳间隔
 * @param {number} [options.idleTimeoutMs] 无入站流量超时
 * @param {number} [options.handshakeTimeoutMs] 握手超时（同时是整个升级阶梯的总预算）
 * @param {import('../rtc/polyfill.mjs').LoadedRtcPolyfill} [options.rtc] RTC 构造器
 * @param {typeof import('../rtc/polyfill.mjs').loadNodeRtcPolyfill} [options.loadRtc] RTC 加载函数（测试注入）
 * @param {typeof createLinkPipe} [options.createPipe] pipe 工厂（测试注入）
 * @param {number} [options.iceCandidateSettleMs] 候选收齐窗口覆盖（测试注入）
 * @param {number} [options.iceGatheringStallMs] gathering 停滞窗口覆盖（测试注入）
 * @param {{ nodeHash?: string, nodePubKey?: string, secretKey?: Uint8Array, nonce?: string } | null} [options.localIdentity] 本地握手身份
 * @returns {Promise<import('./index.mjs').LinkHandle>} link 句柄
 */
export async function createWebRtcLink(options) {
	const handshakeTimeoutMs = Number(options.handshakeTimeoutMs) || ms('10s')
	const channelOpenTimeoutMs = Math.max(handshakeTimeoutMs, ms('30s'))
	const loadRtc = options.loadRtc ?? loadNodeRtcPolyfill
	const icePolicy = getSignalingRuntimeConfig().channels.webrtc?.iceLocalHostnamePolicy
	const rungs = iceLocalHostnameLadder(icePolicy)
	const remoteSignalQueue = []
	const seenRemoteSignals = createLruMap(1024)
	/** @type {InstanceType<import('../rtc/polyfill.mjs').LoadedRtcPolyfill['RTCPeerConnection']> & { onicecandidate?: unknown, ondatachannel?: unknown, onconnectionstatechange?: unknown }} */
	let peerConnection = null
	let remoteDescriptionSet = false
	let controlChannel = null
	let bulkChannel = null
	let unlistenRemote = null
	let sendQueues = null
	let controlLowEvents = 0
	let bulkLowEvents = 0
	let reconnectCount = 0
	let rungIndex = 0
	/** 当前一级收到的 ICE 候选数（polyfill 不把候选写进 SDP，故单独计数）。 */
	let localCandidateCount = 0

	/**
	 * @param {unknown} message 信令载荷
	 * @returns {Promise<void>}
	 */
	async function sendSignal(message) {
		await Promise.resolve(options.signal.send(message))
	}

	const createPipe = options.createPipe ?? createLinkPipe
	const pipe = createPipe({
		providerId: 'webrtc',
		level: LINK_LEVEL_WEBRTC,
		initiator: !!options.initiator,
		nodeHash: options.nodeHash,
		localIdentity: options.localIdentity,
		heartbeatMs: options.heartbeatMs,
		idleTimeoutMs: options.idleTimeoutMs,
		handshakeTimeoutMs,
		/** @returns {string} 本端 DTLS fingerprint（取当前一级的 peer connection） */
		getLocalBinding: () => extractDtlsFingerprint(peerConnection?.localDescription?.sdp || ''),
		/** @returns {string} 对端 DTLS fingerprint */
		getRemoteBinding: () => extractDtlsFingerprint(peerConnection?.remoteDescription?.sdp || ''),
		/**
		 * @param {string} text control JSON
		 * @returns {void}
		 */
		sendControlText(text) {
			if (!controlChannel) throw new Error('p2p: control channel unavailable')
			controlChannel.send(text)
		},
		/**
		 * @param {string} action envelope action
		 * @param {Uint8Array} frame 帧字节
		 * @returns {void}
		 */
		sendFrame(action, frame) {
			if (!sendQueues) throw new Error('p2p: send queues unavailable')
			sendQueues.enqueue(action, frame)
		},
		/**
		 * @returns {Promise<void>}
		 */
		async closeTransport() {
			unlistenRemote?.()
			sendQueues?.clear()
			try { controlChannel?.close() } catch { /* ignore */ }
			try { bulkChannel?.close() } catch { /* ignore */ }
			try { await peerConnection?.close() } catch { /* ignore */ }
		},
		/**
		 * @returns {object} WebRTC 附加 stats
		 */
		extraStats() {
			return {
				connectionState: peerConnection?.connectionState,
				iceConnectionState: peerConnection?.iceConnectionState,
				iceLocalHostnamePolicy: rungs[rungIndex],
				iceRung: rungIndex,
				reconnectCount,
				pending: sendQueues?.pending() ?? { control: 0, bulk: 0 },
				controlBufferedAmount: controlChannel?.bufferedAmount ?? 0,
				bulkBufferedAmount: bulkChannel?.bufferedAmount ?? 0,
				controlLowEvents,
				bulkLowEvents,
			}
		},
	})

	/**
	 * @param {RTCDataChannel} channel RTC 数据通道
	 * @returns {void}
	 */
	function attachBackpressurePump(channel) {
		configureBufferedAmountLowThreshold(channel, CHANNEL_LOW_THRESHOLD_BYTES)
		onBufferedAmountLow(channel, () => {
			if (channel.label === CHANNEL_CONTROL) {
				controlLowEvents++
				sendQueues?.flush(CHANNEL_CONTROL)
			}
			else if (channel.label === CHANNEL_BULK) {
				bulkLowEvents++
				sendQueues?.flush(CHANNEL_BULK)
			}
		})
	}

	/**
	 * @param {RTCSessionDescriptionInit | RTCSessionDescription} description 远端会话描述
	 * @returns {Promise<void>}
	 */
	async function applyRemoteDescription(description) {
		await peerConnection.setRemoteDescription(description)
		remoteDescriptionSet = true
		await flushQueuedIceCandidates()
	}

	/**
	 * 取第 index 级策略对应的 RTC 构造器（策略在包装期烘入，故每级都要重新取）。
	 * @param {number} index 阶梯下标
	 * @returns {Promise<import('../rtc/polyfill.mjs').LoadedRtcPolyfill>} RTC 构造器
	 */
	function rtcForRung(index) {
		if (options.rtc) return options.rtc
		return loadRtc({ policy: rungs[Math.min(index, rungs.length - 1)] })
	}

	/**
	 * 用第 index 级策略重建 peer connection（换级即换 pc：一次全新建链尝试）。
	 * @param {number} index 阶梯下标
	 * @returns {Promise<void>}
	 */
	async function buildPeerConnection(index) {
		const previous = peerConnection
		rungIndex = Math.min(index, rungs.length - 1)
		const rtc = await rtcForRung(rungIndex)
		peerConnection = new rtc.RTCPeerConnection(options.iceServers?.length ? { iceServers: options.iceServers } : undefined)
		remoteDescriptionSet = false
		remoteSignalQueue.length = 0
		localCandidateCount = 0
		attachPeerConnection(peerConnection)
		if (previous)
			try { await previous.close() } catch { /* ignore */ }
		nodeDebug('p2p:webrtc ice rung', {
			rung: rungIndex,
			policy: rungs[rungIndex],
			rungs: rungs.length,
		})
	}

	/**
	 * 确保当前已有一级 peer connection：接受方在收到第一份信令前也要有实例才能 setRemoteDescription。
	 * @returns {Promise<void>}
	 */
	async function ensurePeerConnection() {
		if (!peerConnection) await buildPeerConnection(rungIndex)
	}

	/**
	 * 给 peer connection 挂上事件与回调（换级重建后需重新挂）。
	 * @param {RTCPeerConnection} connection peer connection
	 * @returns {void}
	 */
	function attachPeerConnection(connection) {
		// 候选随 description 一次性带出（对端要先有 remoteDescription 才吃候选），故这里只计数、不外发。
		// 事件 API 由后端提供（W3C 是 addEventListener）；缺失时退化为 onicecandidate 计数。
		const countCandidate = event => {
			if (event?.candidate) localCandidateCount++
		}
		if (connection.addEventListener) connection.addEventListener('icecandidate', countCandidate)
		else {
			const previousHandler = connection.onicecandidate
			connection.onicecandidate = event => {
				countCandidate(event)
				previousHandler?.(event)
			}
		}
		connection.ondatachannel = event => {
			attachChannel(event.channel)
			void maybeStartPostOpenFlow().catch(error => pipe.close(`channel-attach-failed:${formatErrorReason(error)}`))
		}
		connection.onconnectionstatechange = () => {
			if (['failed', 'closed', 'disconnected'].includes(connection.connectionState)) {
				reconnectCount++
				void pipe.close(`connection-${connection.connectionState}`)
			}
		}
	}

	/**
	 * 等本地候选收齐（停滞判定见 [collectIceGathering]），并回报本次是否产出了候选。
	 * @returns {Promise<boolean>} 是否收到过候选
	 */
	async function waitForIceGatheringComplete() {
		try {
			await collectIceGathering({
				iceGatheringState: () => peerConnection.iceGatheringState,
				candidateCount: () => localCandidateCount,
				handshakeTimeoutMs,
				settleMs: options.iceCandidateSettleMs,
				stallMs: options.iceGatheringStallMs,
				onStall: elapsedMs => nodeDebug('p2p:webrtc ice gathering stalled without candidates', {
					elapsedMs,
					rung: rungIndex,
					policy: rungs[rungIndex],
					iceServers: options.iceServers?.length || 0,
				}),
			})
		}
		catch (error) {
			await pipe.close('ice-gathering-timeout')
			throw error
		}
		return localCandidateCount > 0
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function flushQueuedIceCandidates() {
		if (!remoteDescriptionSet || !peerConnection.localDescription) return
		while (remoteSignalQueue.length) {
			const candidate = remoteSignalQueue.shift()
			try {
				await peerConnection.addIceCandidate(candidate)
			}
			catch (error) {
				if (/without ice transport/i.test(String(error?.message ?? error))) {
					remoteSignalQueue.unshift(candidate)
					return
				}
				throw error
			}
		}
	}

	/**
	 * @param {unknown} message 信令消息
	 * @returns {Promise<void>}
	 */
	async function handleRemoteSignal(message) {
		if (!message?.type) return
		// 信令与建链是并发的：任何入站信令都要先确保当前这一级已有可用 pc。
		await ensurePeerConnection()
		const signalKey = message.type === 'ice' && message.candidate
			? `ice:${message.candidate.candidate ?? ''}:${message.candidate.sdpMid ?? ''}:${message.candidate.sdpMLineIndex ?? ''}`
			: JSON.stringify(message)
		if (seenRemoteSignals.has(signalKey)) return
		seenRemoteSignals.touch(signalKey, true)
		if (message.type === 'description' && message.description) {
			// 接受方按 offer 的级号重建，保证自己的候选过滤策略与发起方同一级；自身不升级，
			// 所以阶梯收敛有界（由发起方的观测结果驱动）。
			const remoteRung = Number.isInteger(message.rung) ? Math.max(0, message.rung) : 0
			if (message.description.type === 'offer' && !options.initiator && remoteRung !== rungIndex)
				await buildPeerConnection(remoteRung)
			if (message.description.type === 'answer' && peerConnection.signalingState === 'stable') return
			await applyRemoteDescription(message.description)
			if (message.description.type === 'offer') {
				const answer = await peerConnection.createAnswer()
				await peerConnection.setLocalDescription(answer)
				await flushQueuedIceCandidates()
				const hasCandidates = await waitForIceGatheringComplete()
				nodeDebug('p2p:webrtc answer gathered', {
					rung: rungIndex,
					policy: rungs[rungIndex],
					candidates: localCandidateCount,
					hasCandidates,
				})
				await sendSignal({
					type: 'description',
					rung: rungIndex,
					description: peerConnection.localDescription?.toJSON?.() ?? peerConnection.localDescription ?? answer,
				})
				await pipe.maybeSendAuth()
			}
			return
		}
		if (message.type === 'ice' && message.candidate) {
			if (!remoteDescriptionSet || !peerConnection.localDescription || peerConnection.signalingState !== 'stable') {
				remoteSignalQueue.push(message.candidate)
				return
			}
			try {
				await peerConnection.addIceCandidate(message.candidate)
			}
			catch (error) {
				if (/without ice transport/i.test(String(error?.message ?? error))) {
					remoteSignalQueue.push(message.candidate)
					return
				}
				throw error
			}
		}
	}

	/**
	 * @param {RTCDataChannel} channel RTC 数据通道
	 * @returns {void}
	 */
	function attachChannel(channel) {
		if (channel.label === CHANNEL_CONTROL) controlChannel = channel
		else if (channel.label === CHANNEL_BULK) bulkChannel = channel
		else return
		/**
		 * @param {MessageEvent} event 入站消息事件
		 * @returns {void}
		 */
		channel.onmessage = event => {
			try {
				const { data } = event
				pipe.handleInbound(typeof data === 'string' ? data : toBytes(data, { allowString: true }))
			}
			catch { /* drop */ }
		}
		attachBackpressurePump(channel)
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function maybeStartPostOpenFlow() {
		if (!controlChannel || !bulkChannel) return
		await Promise.all([
			waitForChannelState(controlChannel, 'open', channelOpenTimeoutMs),
			waitForChannelState(bulkChannel, 'open', channelOpenTimeoutMs),
		])
		if (!sendQueues)
			sendQueues = createChannelSendQueues({
				/**
				 * @param {'control' | 'bulk'} name 通道名
				 * @returns {RTCDataChannel | null | undefined} 对应通道
				 */
				getChannel: name => name === CHANNEL_CONTROL ? controlChannel : bulkChannel,
			})
		await pipe.startHandshake()
	}

	unlistenRemote = options.signal.onRemote(message => {
		void handleRemoteSignal(message).catch(error => pipe.close(`signal-error:${formatErrorReason(error)}`))
	}) ?? null

	// 信令随时可能到，故先为当前一级建好 pc（发起方随后会在阶梯里逐级重建）。
	await ensurePeerConnection()

	if (options.initiator) {
		// ICE 阶梯：一级 gathering 后候选集为空就升到更宽松的一级，用全新 peer connection 重发 offer。
		// 总预算沿用 handshakeTimeoutMs，故整条阶梯（含最后一级的数据通道等待）仍有界。
		const ladderDeadline = Date.now() + handshakeTimeoutMs
		let sentOffer = false
		for (let index = 0; index < rungs.length; index++) {
			await buildPeerConnection(index)
			attachChannel(peerConnection.createDataChannel(CHANNEL_CONTROL))
			attachChannel(peerConnection.createDataChannel(CHANNEL_BULK))
			const offer = await peerConnection.createOffer()
			await peerConnection.setLocalDescription(offer)
			const hasCandidates = await waitForIceGatheringComplete()
			nodeDebug('p2p:webrtc offer gathered', {
				rung: index,
				policy: rungs[index],
				candidates: localCandidateCount,
			})
			// 候选集为空说明这一级策略把本机候选全滤掉了（例如只产出 mDNS 候选），换更宽松的一级重建。
			// 只在预算内、且还有更宽松的一级时升级；`rewrite-loopback` 起点不会走到这里（阶梯只有它自己）。
			if (!hasCandidates && Date.now() < ladderDeadline && index + 1 < rungs.length) {
				nodeDebug('p2p:webrtc ice rung escalated', {
					from: rungs[index],
					to: rungs[index + 1],
					rung: index + 1,
				})
				continue
			}
			await sendSignal({
				type: 'description',
				rung: index,
				description: peerConnection.localDescription?.toJSON?.() ?? peerConnection.localDescription ?? offer,
			})
			sentOffer = true
			if (!hasCandidates)
				nodeDebug('p2p:webrtc offer has no usable ice candidates', {
					rung: index,
					policy: rungs[index],
					escalatable: index + 1 < rungs.length,
					iceServers: options.iceServers?.length || 0,
				})
			break
		}
		if (!sentOffer) {
			await pipe.close('ice-candidates-empty')
			throw new Error('p2p: no usable ice candidates after the local hostname ladder')
		}
	}

	void maybeStartPostOpenFlow().catch(error => pipe.close(`open-flow-failed:${formatErrorReason(error)}`))

	return asLinkHandle(pipe, {
		/**
		 * @internal 仅 live 背压测试用，不属公开 LinkHandle
		 * @param {'control' | 'bulk'} name 通道名
		 * @returns {RTCDataChannel | null} 测试用通道
		 */
		channelForTest(name) {
			return name === CHANNEL_CONTROL ? controlChannel : bulkChannel
		},
	})
}

/**
 * 创建 WebRTC LinkProvider。
 * @param {object} [options] 可选覆盖
 * @param {typeof createWebRtcLink} [options.createWebRtcLink] 链路工厂（测试注入）
 * @returns {import('./index.mjs').LinkProvider} WebRTC provider
 */
export function createWebRtcLinkProvider(options = {}) {
	const createImpl = options.createWebRtcLink ?? createWebRtcLink
	return {
		id: 'webrtc',
		level: LINK_LEVEL_WEBRTC,
		caps: { needsOfferAnswer: true, needsDiscoverySignal: true, probe: 'native' },
		isAvailable: canUseWebRtcLink,
		/**
		 * @param {object} dialOptions dial 参数（含 signal / iceServers 等）
		 * @returns {Promise<import('./index.mjs').LinkHandle>} 已建链句柄
		 */
		async dial(dialOptions) {
			return createImpl({ ...dialOptions, initiator: true })
		},
		/**
		 * @param {object} acceptOptions accept 参数
		 * @returns {Promise<import('./index.mjs').LinkHandle>} 已建链句柄
		 */
		async accept(acceptOptions) {
			return createImpl({ ...acceptOptions, initiator: false })
		},
	}
}
