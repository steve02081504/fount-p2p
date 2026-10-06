import { test } from 'node:test'

import { createWebRtcLink } from '../../link/providers/webrtc.mjs'
import { wrapRtcPeerConnectionForIceLocalHostname } from '../../link/rtc/index.mjs'
import { ICE_LOCAL_HOSTNAME_LADDER, iceLocalHostnameLadder } from '../../node/signaling_config.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/** 测试用 ICE candidate。 */
class FakeIceCandidate {
	/**
	 * @param {{ candidate: string }} init candidate 字段
	 */
	constructor(init) {
		this.candidate = init.candidate
	}
}

/** 只有 `.local` host name 的候选：`drop` 会把它丢掉，`none` 会保留。 */
const LOCAL_HOSTNAME_CANDIDATE = 'candidate:1 1 udp 2130706431 eden.local 54321 typ host'
/** 普通 host 候选：任何策略都保留。 */
const PLAIN_HOST_CANDIDATE = 'candidate:2 1 udp 2130706430 10.0.0.5 54322 typ host'

/**
 * 假 RTCPeerConnection：候选由测试推进（[advanceGathering]）经真实包装类过滤后以事件派发，
 * 与 node-datachannel polyfill 的实际行为一致（候选不进 `localDescription.sdp`）。
 */
class FakePeerConnection extends globalThis.EventTarget {
	constructor() {
		super()
		this.localDescription = null
		this.remoteDescription = null
		this.signalingState = 'stable'
		this.iceGatheringState = 'gathering'
		this.connectionState = 'new'
		this.iceConnectionState = 'new'
		this.pollCount = 0
		this.channelLabels = []
	}
	/**
	 * @param {object} description 本地描述
	 * @returns {Promise<void>}
	 */
	async setLocalDescription(description) {
		this.localDescription = { type: description.type, sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' }
		this.pollCount = 0
	}
	/**
	 * @returns {Promise<{ type: string, sdp: string }>} offer
	 */
	async createOffer() {
		return { type: 'offer', sdp: 'v=0\r\no=- offer\r\n' }
	}
	/**
	 * @returns {Promise<{ type: string, sdp: string }>} answer
	 */
	async createAnswer() {
		return { type: 'answer', sdp: 'v=0\r\no=- answer\r\n' }
	}
	/**
	 * @param {object} description 远端描述
	 * @returns {Promise<void>}
	 */
	async setRemoteDescription(description) {
		this.remoteDescription = { ...description, toJSON: () => ({ type: description.type, sdp: description.sdp }) }
	}
	/**
	 * @returns {Promise<void>}
	 */
	async addIceCandidate() { }
	/**
	 * @returns {Promise<void>}
	 */
	async close() { }
	/**
	 * @param {string} label 通道名
	 * @returns {object} 假数据通道
	 */
	createDataChannel(label) {
		this.channelLabels.push(label)
		return { label, onmessage: null, send() { }, close() { } }
	}
	/**
	 * 推进一次 gathering：第二次被观测时派发一次候选，之后不再产出（模拟候选收齐后安静下来）。
	 * @param {string} candidateSdp 要派发的候选 SDP 行
	 */
	advanceGathering(candidateSdp) {
		this.pollCount++
		if (this.pollCount !== 2) return
		const event = new globalThis.Event('icecandidate')
		event.candidate = new FakeIceCandidate({ candidate: candidateSdp })
		this.dispatchEvent(event)
	}
}

/** 假 RTC 后端：记录每级策略，并把包装后的类交给被测代码。 */
class FakeRtcBackend {
	constructor() {
		/** @type {string[]} */
		this.policies = []
		/** @type {FakePeerConnection[]} */
		this.connections = []
	}
	/**
	 * @param {string} policy ICE 本地主机名策略
	 * @returns {{ RTCPeerConnection: unknown, RTCIceCandidate: unknown, backend: string }} polyfill 形状
	 */
	polyfillFor(policy) {
		this.policies.push(policy)
		const connections = this.connections
		class TrackedPeerConnection extends FakePeerConnection {
			constructor(config) {
				super()
				this.config = config
				connections.push(this)
			}
		}
		const Wrapped = wrapRtcPeerConnectionForIceLocalHostname(
			/** @type {typeof RTCPeerConnection} */ /** @type {unknown} */ (TrackedPeerConnection),
			/** @type {typeof RTCIceCandidate} */ /** @type {unknown} */ (FakeIceCandidate),
			policy,
		)
		return { RTCPeerConnection: Wrapped, RTCIceCandidate: FakeIceCandidate, backend: 'fake' }
	}
}

/**
 * 造一个不会自己完成的 pipe 替身：被测代码只用到它的回调与 close。
 * @param {(options: object) => void} capture 捕获 pipe options
 * @returns {object} pipe 替身
 */
function createStubPipe(capture) {
	/** @type {string[]} */
	const closedReasons = []
	const pipe = {
		ready: new Promise(() => { }),
		nodeHash: null,
		initiator: false,
		/** @returns {void} */		handleInbound() { },
		/** @returns {() => void} */
		onEnvelope() { return () => { } },
		/** @returns {() => void} */
		onDown() { return () => { } },
		/** @returns {() => void} */
		onRtt() { return () => { } },
		/**
		 * @param {string} reason 关闭原因
		 * @returns {Promise<void>}
		 */
		async close(reason) { closedReasons.push(reason) },
		/** @returns {Promise<void>} */
		async startHandshake() { },
		/** @returns {Promise<void>} */
		async maybeSendAuth() { },
		/** @returns {object} 统计 */
		stats() { return { rttMs: null, avgRttMs: null } },
		closedReasons,
	}
	capture(pipe)
	return pipe
}

/**
 * 跑一次建链，返回出站信令与策略序列。
 * @param {{ initiator?: boolean, candidateSdp?: string, inboundSignals?: object[], handshakeTimeoutMs?: number, iceCandidateSettleMs?: number, iceGatheringStallMs?: number }} [options] 测试参数
 * @returns {Promise<{ sent: object[], policies: string[], rejected: Error | null, closedReasons: string[] }>} 结果
 */
async function runWebRtcLink(options = {}) {
	const backend = new FakeRtcBackend()
	const candidateSdp = options.candidateSdp ?? LOCAL_HOSTNAME_CANDIDATE
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000
	/** @type {object[]} */
	const sent = []
	/** @type {((message: object) => void) | null} */
	let inbound = null
	let stub = null
	// 推进各轮 gathering（真实代码每 50ms 轮询一次本地候选数）。
	const advance = setInterval(() => {
		for (const connection of backend.connections) connection.advanceGathering(candidateSdp)
	}, 20)
	const linking = createWebRtcLink({
		initiator: !!options.initiator,
		nodeHash: 'b'.repeat(64),
		signal: {
			/**
			 * @param {object} message 出站信令
			 * @returns {void}
			 */
			send(message) { sent.push(message) },
			/**
			 * @param {(message: object) => void} handler 入站处理器
			 * @returns {() => void} 取消订阅
			 */
			onRemote(handler) {
				inbound = handler
				return () => { inbound = null }
			},
		},
		handshakeTimeoutMs,
		iceServers: [],
		// 阶梯测试不该依赖真实墙钟窗口（全量并发时会抖动）。
		iceCandidateSettleMs: options.iceCandidateSettleMs ?? 60,
		iceGatheringStallMs: options.iceGatheringStallMs ?? 120,
		/**
		 * @param {{ policy?: string }} [loadOptions] 策略覆盖
		 * @returns {Promise<object>} polyfill
		 */
		async loadRtc(loadOptions = {}) {
			return backend.polyfillFor(loadOptions.policy)
		},
		/**
		 * @param {object} pipeOptions pipe 配置
		 * @returns {object} pipe 替身
		 */
		createPipe(pipeOptions) {
			stub = createStubPipe(() => { })
			stub.initiator = !!pipeOptions.initiator
			return stub
		},
	})
	/** @type {Error | null} */
	let rejected = null
	try {
		await linking
	}
	catch (error) {
		rejected = /** @type {Error} */ (error)
	}
	if (options.inboundSignals?.length && inbound) {
		for (const message of options.inboundSignals) {
			/** @type {(message: object) => void} */ (inbound)(message)
			// 入站处理是 fire-and-forget，只能按停滞/超时窗口等待。
			await new Promise(resolve => setTimeout(resolve, 2_500))
		}
	}
	clearInterval(advance)
	return { sent, policies: backend.policies, rejected, closedReasons: stub?.closedReasons ?? [] }
}

/**
 * @param {number} rung 级号
 * @returns {object} 入站 offer 信令
 */
function offerFor(rung) {
	return { type: 'description', rung, description: { type: 'offer', sdp: 'v=0\r\no=- remote-offer\r\n' } }
}

test('iceLocalHostnameLadder escalates from drop to none and honours an explicit start', () => {
	assertEquals(ICE_LOCAL_HOSTNAME_LADDER, ['drop', 'none'])
	assertEquals(iceLocalHostnameLadder(undefined), ['drop', 'none'])
	assertEquals(iceLocalHostnameLadder('drop'), ['drop', 'none'])
	assertEquals(iceLocalHostnameLadder('none'), ['none'])
	// 调试/同机策略不应自动放宽成对外候选。
	assertEquals(iceLocalHostnameLadder('rewrite-loopback'), ['rewrite-loopback'])
})

test('initiator escalates to the next rung when a policy drains every local candidate', async () => {
	const result = await runWebRtcLink({ initiator: true, candidateSdp: LOCAL_HOSTNAME_CANDIDATE, handshakeTimeoutMs: 2_000 })
	assertEquals(result.rejected, null)
	assertEquals(result.policies[0], 'drop')
	assertEquals(result.policies.includes('none'), true, `policies=${JSON.stringify(result.policies)}`)
	const offers = result.sent.filter(message => message.type === 'description')
	assertEquals(offers.length, 1, 'only the accepted rung offer is sent')
	assertEquals(offers[0].rung > 0, true, 'offer came from an escalated rung')
	// 候选不走 SDP 文本（node-datachannel 只经 icecandidate 事件派发），故这里不校验候选行。
	assertEquals(String(offers[0].description.type), 'offer')
})

test('initiator does not escalate when the first rung already produced candidates', async () => {
	const result = await runWebRtcLink({ initiator: true, candidateSdp: PLAIN_HOST_CANDIDATE, handshakeTimeoutMs: 2_000 })
	assertEquals(result.rejected, null)
	// 第 0 级就有候选：不应再取用更宽松的一级。
	assertEquals(result.policies.includes('none'), false, `policies=${JSON.stringify(result.policies)}`)
	const offers = result.sent.filter(message => message.type === 'description')
	assertEquals(offers.length, 1)
	assertEquals(offers[0].rung, 0)
})

test('responder rebuilds on the rung the offer names and echoes it in the answer', async () => {
	const result = await runWebRtcLink({
		initiator: false,
		candidateSdp: PLAIN_HOST_CANDIDATE,
		handshakeTimeoutMs: 2_000,
		inboundSignals: [offerFor(1)],
	})
	assertEquals(result.rejected, null)
	// 接受方按 offer 的级号重建：最后一次取用的策略应当是 none（第 1 级）。
	assertEquals(result.policies.at(-1), 'none')
	const answers = result.sent.filter(message => message.type === 'description')
	assertEquals(answers.length, 1)
	assertEquals(answers[0].rung, 1)
})
test('responder stays on rung 0 when the offer does not name a rung', async () => {
	const result = await runWebRtcLink({
		initiator: false,
		candidateSdp: PLAIN_HOST_CANDIDATE,
		handshakeTimeoutMs: 2_000,
		inboundSignals: [{ type: 'description', description: { type: 'offer', sdp: 'v=0\r\no=- remote-offer\r\n' } }],
	})
	assertEquals(result.rejected, null)
	assertEquals(result.policies.at(-1), 'drop')
	const answers = result.sent.filter(message => message.type === 'description')
	assertEquals(answers.length, 1)
	assertEquals(answers[0].rung, 0)
})
