import { getSignalingRuntimeConfig } from '../../node/instance.mjs'
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
import {
	attachDataChannelListener,
	attachIceCandidateListener,
	loadNodeRtcPolyfill,
	signalDataToBytes,
	waitForChannelState,
} from '../rtc.mjs'
import { extractDtlsFingerprint } from '../sdp_fingerprint.mjs'

import { LINK_LEVEL_WEBRTC } from './levels.mjs'

/**
 * 将错误对象格式化为短字符串。
 * @param {unknown} error 原始错误
 * @returns {string} 短 reason
 */
function formatErrorReason(error) {
	return String(error?.message ?? error ?? 'unknown-error').replace(/\s+/g, ' ').slice(0, 240)
}

/**
 * 绑定 data channel message 回调。
 * @param {RTCDataChannel} channel RTC 数据通道
 * @param {(data: unknown) => void} handler 消息处理器
 * @returns {void}
 */
function attachChannelMessageListener(channel, handler) {
	channel.addEventListener?.('message', event => handler(event?.data))
	/**
	 * @param {MessageEvent} event 消息事件
	 * @returns {void}
	 */
	channel.onmessage = event => handler(event?.data)
	channel.onMessage?.subscribe(message => handler(message))
}

let cachedAvailable = null

/**
 * 探测 WebRTC（node-datachannel）是否可用。
 * @returns {Promise<boolean>} 可用为 true
 */
export async function canUseWebRtcLink() {
	if (cachedAvailable !== null) return cachedAvailable
	try {
		await loadNodeRtcPolyfill()
		cachedAvailable = true
	}
	catch {
		cachedAvailable = false
	}
	return cachedAvailable
}

/**
 * 建立 WebRTC link（双 DataChannel + discovery 信令）。
 * @param {object} options link 配置
 * @param {string | null} [options.nodeHash] 期望的对端 nodeHash
 * @param {boolean} options.initiator 是否为连接发起方
 * @param {{ send: (message: unknown) => void | Promise<void>, onRemote: (handler: (message: unknown) => void) => (() => void) | void }} options.signal 信令收发接口
 * @param {RTCConfiguration['iceServers']} [options.iceServers] ICE 服务器列表
 * @param {number} [options.heartbeatMs] 心跳间隔
 * @param {number} [options.idleTimeoutMs] 无入站流量超时
 * @param {number} [options.handshakeTimeoutMs] 握手超时
 * @param {{ RTCPeerConnection: typeof RTCPeerConnection } | null} [options.rtc] RTC 构造器
 * @param {{ nodeHash?: string, nodePubKey?: string, secretKey?: Uint8Array, nonce?: string } | null} [options.localIdentity] 本地握手身份
 * @returns {Promise<import('./index.mjs').LinkHandle>} link 句柄
 */
export async function createWebRtcLink(options) {
	const handshakeTimeoutMs = Number(options.handshakeTimeoutMs) || ms('10s')
	const channelOpenTimeoutMs = Math.max(handshakeTimeoutMs, ms('30s'))
	const trickleIceOff = getSignalingRuntimeConfig().trickleIceOff === true
	const rtc = options.rtc ?? await loadNodeRtcPolyfill()
	const pc = new rtc.RTCPeerConnection(options.iceServers?.length ? { iceServers: options.iceServers } : undefined)
	const remoteSignalQueue = []
	const seenRemoteSignals = createLruMap(1024)
	let remoteDescriptionSet = false
	let controlChannel = null
	let bulkChannel = null
	let unlistenRemote = null
	let sendQueues = null
	let controlLowEvents = 0
	let bulkLowEvents = 0
	let reconnectCount = 0

	/**
	 * @param {unknown} message 信令载荷
	 * @returns {Promise<void>}
	 */
	async function sendSignal(message) {
		await Promise.resolve(options.signal.send(message))
	}

	const pipe = createLinkPipe({
		providerId: 'webrtc',
		level: LINK_LEVEL_WEBRTC,
		initiator: !!options.initiator,
		nodeHash: options.nodeHash,
		localIdentity: options.localIdentity,
		heartbeatMs: options.heartbeatMs,
		idleTimeoutMs: options.idleTimeoutMs,
		handshakeTimeoutMs,
		/** @returns {string} 本端 DTLS fingerprint */
		getLocalBinding: () => extractDtlsFingerprint(pc.localDescription?.sdp || ''),
		/** @returns {string} 对端 DTLS fingerprint */
		getRemoteBinding: () => extractDtlsFingerprint(pc.remoteDescription?.sdp || ''),
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
			try { await pc.close() } catch { /* ignore */ }
		},
		/**
		 * @returns {object} WebRTC 附加 stats
		 */
		extraStats() {
			return {
				connectionState: pc.connectionState,
				iceConnectionState: pc.iceConnectionState,
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
			if (channel.label === CHANNEL_CONTROL) controlLowEvents++
			if (channel.label === CHANNEL_BULK) bulkLowEvents++
			if (channel.label === CHANNEL_CONTROL) sendQueues?.flush(CHANNEL_CONTROL)
			if (channel.label === CHANNEL_BULK) sendQueues?.flush(CHANNEL_BULK)
		})
	}

	/**
	 * @param {RTCSessionDescriptionInit | RTCSessionDescription} description 远端会话描述
	 * @returns {Promise<void>}
	 */
	async function applyRemoteDescription(description) {
		await pc.setRemoteDescription(description)
		remoteDescriptionSet = true
		await flushQueuedIceCandidates()
	}

	/**
	 * @param {unknown} error addIceCandidate 错误
	 * @returns {boolean} 是否应暂存后重试
	 */
	function shouldRetryQueuedIce(error) {
		return /without ice transport/i.test(String(error?.message ?? error ?? ''))
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function waitForIceGatheringComplete() {
		if (!trickleIceOff || pc.iceGatheringState === 'complete') return
		const deadline = Date.now() + handshakeTimeoutMs
		while (pc.iceGatheringState !== 'complete' && Date.now() < deadline)
			await new Promise(resolve => setTimeout(resolve, 50))
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function flushQueuedIceCandidates() {
		if (!remoteDescriptionSet || !pc.localDescription) return
		while (remoteSignalQueue.length) {
			const candidate = remoteSignalQueue.shift()
			try {
				await pc.addIceCandidate(candidate)
			}
			catch (error) {
				if (shouldRetryQueuedIce(error)) {
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
		if (!message || typeof message !== 'object') return
		const signalKey = JSON.stringify(message)
		if (seenRemoteSignals.has(signalKey)) return
		seenRemoteSignals.touch(signalKey, true)
		if (message.type === 'description' && message.description) {
			if (message.description.type === 'answer' && pc.signalingState === 'stable') return
			await applyRemoteDescription(message.description)
			if (message.description.type === 'offer') {
				const answer = await pc.createAnswer()
				await pc.setLocalDescription(answer)
				await flushQueuedIceCandidates()
				await waitForIceGatheringComplete()
				await sendSignal({
					type: 'description',
					description: pc.localDescription?.toJSON?.() ?? pc.localDescription ?? answer,
				})
				await pipe.maybeSendAuth()
			}
			return
		}
		if (message.type === 'ice' && message.candidate) {
			if (!remoteDescriptionSet || !pc.localDescription || pc.signalingState !== 'stable') {
				remoteSignalQueue.push(message.candidate)
				return
			}
			try {
				await pc.addIceCandidate(message.candidate)
			}
			catch (error) {
				if (shouldRetryQueuedIce(error)) {
					remoteSignalQueue.push(message.candidate)
					return
				}
				throw error
			}
		}
	}

	/**
	 * @param {RTCDataChannel} channel RTC 数据通道
	 * @returns {Promise<void>}
	 */
	async function attachChannel(channel) {
		if (channel.label === CHANNEL_CONTROL) controlChannel = channel
		else if (channel.label === CHANNEL_BULK) bulkChannel = channel
		else return
		attachChannelMessageListener(channel, data => {
			try {
				if (typeof data === 'string') pipe.handleInbound(data)
				else pipe.handleInbound(signalDataToBytes(data))
			}
			catch { /* drop */ }
		})
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

	attachIceCandidateListener(pc, event => {
		if (trickleIceOff || !event.candidate) return
		void sendSignal({
			type: 'ice',
			candidate: typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate,
		}).catch(error => pipe.close(`signal-send-failed:${formatErrorReason(error)}`))
	})
	attachDataChannelListener(pc, event => {
		void attachChannel(event.channel)
			.then(() => maybeStartPostOpenFlow())
			.catch(error => pipe.close(`channel-attach-failed:${error?.message ?? error}`))
	})

	/** 连接失败/关闭时关掉 pipe。 */
	pc.onconnectionstatechange = () => {
		if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
			reconnectCount++
			void pipe.close(`connection-${pc.connectionState}`)
		}
	}

	if (options.initiator) {
		await attachChannel(pc.createDataChannel(CHANNEL_CONTROL))
		await attachChannel(pc.createDataChannel(CHANNEL_BULK))
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		await waitForIceGatheringComplete()
		await sendSignal({
			type: 'description',
			description: pc.localDescription?.toJSON?.() ?? pc.localDescription ?? offer,
		})
	}

	void maybeStartPostOpenFlow().catch(error => pipe.close(`open-flow-failed:${error?.message ?? error}`))

	return asLinkHandle(pipe, {
		/**
		 * @internal 仅 live 背压测试用，不属公开 LinkHandle
		 * @param {'control' | 'bulk'} name 通道名
		 * @returns {RTCDataChannel | null} 测试用通道
		 */
		_channelForTest(name) {
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
		caps: { needsOfferAnswer: true, needsDiscoverySignal: true },
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
