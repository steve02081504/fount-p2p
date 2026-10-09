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
 * `close()` 也照真实后端做：把状态推到 `closed`、经 `connectionstatechange` 通知，之后拒绝再协商。
 */
class FakePeerConnection extends globalThis.EventTarget {
	/**
	 * @param {string | null} candidateSdp gathering 时要派发的候选；null 表示这一级不产出候选
	 */
	constructor(candidateSdp) {
		super()
		this.candidateSdp = candidateSdp
		this.localDescription = null
		this.remoteDescription = null
		this.signalingState = 'stable'
		this.iceGatheringState = 'gathering'
		this.connectionState = 'new'
		this.iceConnectionState = 'new'
		this.pollCount = 0
		this.channelLabels = []
		this.ondatachannel = null
		this.onconnectionstatechange = null
		/** `close()` 次数：被替换掉的那一级只该关一次。 */
		this.closeCalls = 0
		/** `close()` 时是否还挂着状态回调：是的话这次关闭就会连带去关当前存活的那一级（fount-p2p#39）。 */
		this.closedWithStateHandler = false
	}
	/**
	 * @param {object} description 本地描述
	 * @returns {Promise<void>}
	 */
	async setLocalDescription(description) {
		// 与 node-datachannel 同一报错文本：已销毁的连接不能再协商。
		if (this.connectionState === 'closed') throw new Error('setLocalDescription() called on destroyed peer connection')
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
		this.remoteDescription = { ...description,
			/**
			 * 让假描述像真 RTCSessionDescription 一样可序列化。
			 * @returns {{ type: string, sdp: string }} 只含 type/sdp 的普通对象
			 */
			toJSON: () => ({ type: description.type, sdp: description.sdp }) }
	}
	/**
	 * @returns {Promise<void>}
	 */
	async addIceCandidate() { }
	/**
	 * 模拟真实后端：close() 推进到 `closed` 并向 `onconnectionstatechange` 派发通知。
	 * @returns {Promise<void>}
	 */
	async close() {
		this.closeCalls++
		this.closedWithStateHandler = this.onconnectionstatechange !== null
		this.connectionState = 'closed'
		this.onconnectionstatechange?.()
	}
	/**
	 * @param {string} label 通道名
	 * @returns {object} 假数据通道
	 */
	createDataChannel(label) {
		this.channelLabels.push(label)
		return { label, onmessage: null,
			/** 假数据通道的发送端点：不真的发数据。 */
			send() { },
			/** 假数据通道的关闭端点：不真的关资源。 */
			close() { } }
	}
	/**
	 * 推进一次 gathering：第二次被观测时派发一次候选，之后不再产出（模拟候选收齐后安静下来）。
	 */
	advanceGathering() {
		this.pollCount++
		if (this.pollCount !== 2) return
		const event = new globalThis.Event('icecandidate')
		event.candidate = new FakeIceCandidate({ candidate: this.candidateSdp })
		this.dispatchEvent(event)
	}
}

/** 假 RTC 后端：记录每级策略，并把包装后的类交给被测代码。 */
class FakeRtcBackend {
	/**
	 * @param {string | null} candidateSdp 每级连接 gathering 时要派发的候选；null 表示不产出候选
	 */
	constructor(candidateSdp) {
		this.candidateSdp = candidateSdp
		/** @type {string[]} */
		this.policies = []
		/** @type {FakePeerConnection[]} */
		this.connections = []
	}
	/**
	 * 关链前的快照：此时被换掉的那一级应当已经关过（且关闭时不带状态回调），存活的一级应当还没关。
	 * @returns {{ closeCalls: number[], closedWithStateHandler: number[] }} 各连接的关闭次数，以及带着状态回调被关掉的下标
	 */
	closeStates() {
		return {
			closeCalls: this.connections.map(connection => connection.closeCalls),
			closedWithStateHandler: this.connections
				.map((connection, index) => connection.closedWithStateHandler ? index : -1)
				.filter(index => index >= 0),
		}
	}
	/**
	 * @param {string} policy ICE 本地主机名策略
	 * @returns {{ RTCPeerConnection: unknown, RTCIceCandidate: unknown, backend: string }} polyfill 形状
	 */
	polyfillFor(policy) {
		this.policies.push(policy)
		const connections = this.connections
		const candidateSdp = this.candidateSdp
		/**
		 * 记录每一级新建的连接，用例据此检查各级的关闭情况。
		 */
		class TrackedPeerConnection extends FakePeerConnection {
			/**
			 * @param {object} config 传给 RTCPeerConnection 的配置
			 */
			constructor(config) {
				super(candidateSdp)
				this.config = config
				connections.push(this)
			}
		}
		const Wrapped = wrapRtcPeerConnectionForIceLocalHostname(
			/** @type {typeof RTCPeerConnection} */ /** @type {unknown} */ TrackedPeerConnection,
			/** @type {typeof RTCIceCandidate} */ /** @type {unknown} */ FakeIceCandidate,
			policy,
		)
		return { RTCPeerConnection: Wrapped, RTCIceCandidate: FakeIceCandidate, backend: 'fake' }
	}
}

/**
 * 造一个不会自己完成的 pipe 替身：被测代码只用到它的回调与 close。
 * close 照真实 pipe 做两件事——只认第一次关闭原因、并关掉底层传输（否则旧连接的关闭通知影响不到 pc 层）。
 * `ready` 按真实 pipe 的结算方式给出：握手成功才 resolve，建链失败则被异常结算（见 fount-p2p#39 的教训）。
 * @param {object} pipeOptions 传给 pipe 工厂的配置
 * @param {'pending' | 'ready' | 'failed'} readyState ready 的结算状态
 * @returns {object} pipe 替身
 */
function createStubPipe(pipeOptions, readyState = 'pending') {
	/** @type {string[]} */
	const closedReasons = []
	/** 被异常结算的 ready：取值必抛，故先挂一个空 catch 免掉 unhandled rejection。 */
	const rejectedReady = Promise.reject(new Error('p2p: link closed before ready'))
	void rejectedReady.catch(() => { })
	const pipe = {
		ready: readyState === 'ready' ? Promise.resolve()
			: readyState === 'failed' ? rejectedReady
				: new Promise(() => { }),
		nodeHash: null,
		initiator: false,
		/** @returns {void} */		handleInbound() { },
		/** @returns {() => void} 取消订阅函数 */
		onEnvelope() { return () => { } },
		/** @returns {() => void} 取消订阅函数 */
		onDown() { return () => { } },
		/** @returns {() => void} 取消订阅函数 */
		onRtt() { return () => { } },
		/**
		 * @param {string} reason 关闭原因
		 * @returns {Promise<void>}
		 */
		async close(reason) {
			if (closedReasons.length) return
			closedReasons.push(reason)
			await pipeOptions.closeTransport?.()
		},
		/** @returns {Promise<void>} */
		async startHandshake() { },
		/** @returns {Promise<void>} */
		async maybeSendAuth() { },
		/**
		 * 链路统计；`closed` 供重试逻辑判断链路是否已被换掉/关闭。
		 * @returns {{ rttMs: number | null, avgRttMs: number | null, ready: boolean, closed: boolean }} 统计快照
		 */
		stats() { return { rttMs: null, avgRttMs: null, ready: readyState === 'ready', closed: closedReasons.length > 0 } },
		closedReasons,
	}
	return pipe
}

/**
 * 搭一次建链的测试装置：假后端按 [FakeRtcBackend.candidateSdp] 产出候选，pipe 替身只记录关闭原因。
 * @param {{ initiator?: boolean, candidateSdp?: string | null, handshakeTimeoutMs?: number, iceCandidateSettleMs?: number, iceGatheringStallMs?: number, readyState?: 'pending' | 'ready' | 'failed', failAnswerSend?: boolean, failAnswerSendAttempts?: number }} options 测试参数
 * @returns {{ backend: FakeRtcBackend, sent: object[], answerSendAttempts: number, pipeStub: object, linking: Promise<object>, sendInbound: (message: object) => void, stop: () => void }} 装置；`stop` 停掉 gathering 推进
 */
function createLadderHarness(options) {
	const backend = new FakeRtcBackend(options.candidateSdp ?? LOCAL_HOSTNAME_CANDIDATE)
	/** @type {object[]} */
	const sent = []
	/** @type {((message: object) => void) | null} */
	let inbound = null
	let pipeStub = null
	let answerSendAttempts = 0
	// 推进各轮 gathering（真实代码每 50ms 轮询一次本地候选数）。
	const advance = setInterval(() => {
		for (const connection of backend.connections) connection.advanceGathering()
	}, 20)
	const linking = createWebRtcLink({
		initiator: !!options.initiator,
		nodeHash: 'b'.repeat(64),
		signal: {
			/**
			 * @param {object} message 出站信令
			 * @returns {void}
			 */
			send(message) {
				if (message.description?.type !== 'answer') return sent.push(message)
				answerSendAttempts++
				// 两种失败语义：永久失败（responderWithFailingAnswer）或只失败前 N 次（瞬时失败）。
				if (options.failAnswerSend) throw new Error('signal unavailable')
				if (answerSendAttempts <= (options.failAnswerSendAttempts ?? 0)) throw new Error('temporary signal failure')
				if (options.seedPendingAnswer) return options.seedPendingAnswer(message)
				sent.push(message)
			},
			/**
			 * @param {(message: object) => void} handler 入站处理器
			 * @returns {() => void} 取消订阅
			 */
			onRemote(handler) {
				inbound = handler
				return () => { inbound = null }
			},
		},
		handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5_000,
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
			pipeStub = createStubPipe(pipeOptions, options.readyState ?? 'pending')
			pipeStub.initiator = !!pipeOptions.initiator
			return pipeStub
		},
	})
	return {
		backend,
		sent,
		/**
		 * answer 的发送尝试次数（含失败与重试）。
		 * @returns {number} 目前为止的发送次数
		 */
		get answerSendAttempts() { return answerSendAttempts },
		/** @type {object} */ pipeStub: /** @type {object} */ pipeStub,
		linking,
		/** @param {object} message 入站信令 */
		sendInbound(message) { /** @type {(message: object) => void} */ inbound(message) },
		/** 停掉 gathering 推进定时器。 */
		stop() { clearInterval(advance) },
	}
}

/**
 * 跑一次建链，返回出站信令、策略序列与建过的 peer connection。
 * `closeStates` 是收尾关链前的快照：被换掉的一级应当只关过自己、且关闭时已无状态回调；存活的一级应当一次都没关过。
 * @param {{ initiator?: boolean, candidateSdp?: string | null, inboundSignals?: object[], handshakeTimeoutMs?: number, iceCandidateSettleMs?: number, iceGatheringStallMs?: number }} [options] 测试参数
 * @returns {Promise<{ sent: object[], answerSendAttempts: number, policies: string[], connections: FakePeerConnection[], closeStates: { closeCalls: number[], closedWithStateHandler: number[] }, rejected: Error | null, closedReasons: string[] }>} 结果
 */
async function runWebRtcLink(options = {}) {
	const harness = createLadderHarness(options)
	/** @type {Error | null} */
	let rejected = null
	try {
		await harness.linking
	}
	catch (error) {
		rejected = /** @type {Error} */ error
	}
	if (options.inboundSignals?.length)
		for (const message of options.inboundSignals) {
			harness.sendInbound(message)
			// 入站处理是 fire-and-forget，只能按停滞/超时窗口等待。
			await new Promise(resolve => setTimeout(resolve, 2_500))
		}

	harness.stop()
	const { backend, pipeStub } = harness
	return {
		sent: harness.sent,
		answerSendAttempts: harness.answerSendAttempts,
		policies: backend.policies,
		connections: backend.connections,
		closeStates: backend.closeStates(),
		rejected,
		closedReasons: /** @type {{ closedReasons: string[] }} */ pipeStub.closedReasons,
	}
}

/**
 * @param {number} rung 级号
 * @returns {object} 入站 offer 信令
 */
function offerFor(rung) {
	return { type: 'description', rung, description: { type: 'offer', sdp: 'v=0\r\no=- remote-offer\r\n' } }
}

/** 答复发不出去的响应方：只看 ready 状态怎么决定收尾。 */
const responderWithFailingAnswer = {
	initiator: false,
	candidateSdp: PLAIN_HOST_CANDIDATE,
	handshakeTimeoutMs: 2_000,
	failAnswerSend: true,
	inboundSignals: [offerFor(0)],
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
	// 首轮复用 ensurePeerConnection() 建好的第 0 级，升级时才建第 1 级：不建一次性 pc（fount-p2p#39）。
	assertEquals(result.connections.length, 2, `connections=${result.connections.length}`)
	// 被换掉的一级只关过一次（自己），且关闭时已经摘掉回调：旧连接的关闭波不到刚建好的这一级。
	assertEquals(result.closeStates.closeCalls, [1, 0], `closeStates=${JSON.stringify(result.closeStates)}`)
	assertEquals(result.closeStates.closedWithStateHandler, [])
	assertEquals(result.closedReasons, [])
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
	// 阶梯首轮要用的第 0 级已经建好，同一级不再重建：整条链路只该有一个 pc（fount-p2p#39）。
	assertEquals(result.connections.length, 1, `connections=${result.connections.length}`)
	assertEquals(result.closeStates.closeCalls, [0])
	assertEquals(result.closedReasons, [])
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
	// 重建同样要先摘回调再关被换掉的那一级，否则它会关掉答复用的新连接（fount-p2p#39）。
	assertEquals(result.connections.length, 2, `connections=${result.connections.length}`)
	assertEquals(result.closeStates.closeCalls, [1, 0], `closeStates=${JSON.stringify(result.closeStates)}`)
	assertEquals(result.closeStates.closedWithStateHandler, [])
	assertEquals(result.closedReasons, [])
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
	// 同级不重建：接受方收到同级 offer 时继续用已经建好的 pc。
	assertEquals(result.connections.length, 1, `connections=${result.connections.length}`)
	assertEquals(result.closedReasons, [])
	const answers = result.sent.filter(message => message.type === 'description')
	assertEquals(answers.length, 1)
	assertEquals(answers[0].rung, 0)
})

test('responder signal send failure does not close an already ready link', async () => {
	const result = await runWebRtcLink({ ...responderWithFailingAnswer, readyState: 'ready' })
	assertEquals(result.closedReasons, [])
	assertEquals(result.answerSendAttempts, 1, 'ready links do not retry later signalling')
})

test('responder retries a transient answer send failure before closing the link', async () => {
	const result = await runWebRtcLink({
		initiator: false,
		candidateSdp: PLAIN_HOST_CANDIDATE,
		handshakeTimeoutMs: 2_000,
		failAnswerSendAttempts: 2,
		inboundSignals: [offerFor(0)],
	})
	assertEquals(result.answerSendAttempts, 3)
	assertEquals(result.sent.filter(message => message.description?.type === 'answer').length, 1)
	assertEquals(result.closedReasons, [])
})

test('responder stops answer retries after its pipe closes', async () => {
	const harness = createLadderHarness({
		initiator: false,
		candidateSdp: PLAIN_HOST_CANDIDATE,
		handshakeTimeoutMs: 2_000,
		failAnswerSendAttempts: 1,
	})
	try {
		await harness.linking
		harness.sendInbound(offerFor(0))
		const deadline = Date.now() + 1_000
		while (harness.answerSendAttempts === 0 && Date.now() < deadline)
			await new Promise(resolve => setTimeout(resolve, 10))
		assertEquals(harness.answerSendAttempts, 1, 'first send failed before the retry delay')
		await harness.pipeStub.close('test-close-during-retry')
		// 等过第一次重试延迟（200ms）：若关闭没被看见，这里就会多出一次发送。
		await new Promise(resolve => setTimeout(resolve, 250))
		assertEquals(harness.answerSendAttempts, 1, 'closed pipe prevents stale retry')
	}
	finally {
		harness.stop()
	}
})

test('a stale answer failure during a rung switch does not close the link', async () => {
	/** @type {((error: Error) => void) | null} */
	let failPendingSend = null
	/**
	 * 首个 answer 的发布悬挂到测试放行为止：此时 rung 0 的 answer 就是「已经过期但还没失败」的那一个。
	 * @returns {Promise<never>} 永不自行结算的发布 Promise，等测试手动拒绝
	 */
	const seedPendingAnswer = () => new Promise((_resolve, reject) => { failPendingSend = reject })
	const harness = createLadderHarness({
		initiator: false,
		candidateSdp: PLAIN_HOST_CANDIDATE,
		handshakeTimeoutMs: 4_000,
		seedPendingAnswer,
	})
	try {
		await harness.linking
		harness.sendInbound(offerFor(0))
		const firstAnswerDeadline = Date.now() + 1_000
		while (!failPendingSend && Date.now() < firstAnswerDeadline)
			await new Promise(resolve => setTimeout(resolve, 5))
		assertEquals(failPendingSend != null, true, `rung 0 answer is pending (attempts=${harness.answerSendAttempts})`)
		// 换级：rungIndex 同步跳到 1，新 pc 要等 loadRtc 与旧连接收尾后才装上，rung 0 的 answer 此刻过期。
		harness.sendInbound(offerFor(1))
		await Promise.resolve()
		const pendingAnswer = /** @type {(error: Error) => void} */ failPendingSend
		pendingAnswer(new Error('stale answer publish failed'))
		// 等过第一次重试延迟（200ms）：过期 answer 的失败不该再被重试，更不该拆掉活链路。
		await new Promise(resolve => setTimeout(resolve, 400))
		assertEquals(harness.pipeStub.closedReasons, [], 'the live link survives the stale failure')
	}
	finally {
		harness.stop()
	}
})

test('responder signal send failure still closes a link whose ready never succeeded', async () => {
	// 未结算与被异常结算的 ready 都不算「已就绪」：握手从未成功，链路仍该按建链失败处理。
	for (const readyState of ['pending', 'failed']) {
		const result = await runWebRtcLink({ ...responderWithFailingAnswer, readyState })
		assertEquals(result.answerSendAttempts, 3, `readyState=${readyState} retries are bounded`)
		assertEquals(result.closedReasons.length, 1, `readyState=${readyState} closedReasons=${JSON.stringify(result.closedReasons)}`)
		assertEquals(result.closedReasons[0].startsWith('signal-error:'), true, `readyState=${readyState}`)
	}
})

test('closing a rebuilt-away connection never closes the live one', async () => {
	// 第 0 级只产出 `.local` 候选会触发升级，于是被换掉的第 0 级与存活的第 1 级能同时拿到。
	const harness = createLadderHarness({ initiator: true, candidateSdp: LOCAL_HOSTNAME_CANDIDATE, handshakeTimeoutMs: 2_000 })
	await harness.linking
	const [replaced, live] = harness.backend.connections
	// 换级时先摘回调再关：被换掉的那一级身上已经没有状态回调，只有存活的一级还挂着。
	assertEquals(harness.backend.connections.length, 2, `connections=${harness.backend.connections.length}`)
	assertEquals(replaced.onconnectionstatechange, null)
	assertEquals(live.onconnectionstatechange !== null, true)
	// 再按后端方式关掉被换掉的那一级：回调若还在，closeTransport 就会连带关掉存活的一级（fount-p2p#39）。
	await replaced.close()
	harness.stop()
	assertEquals(harness.pipeStub.closedReasons, [], `closedReasons=${JSON.stringify(harness.pipeStub.closedReasons)}`)
	assertEquals(live.connectionState !== 'closed', true, `live=${live.connectionState}`)
})
