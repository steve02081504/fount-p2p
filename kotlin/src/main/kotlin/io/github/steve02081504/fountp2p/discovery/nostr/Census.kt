package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.sign
import io.github.steve02081504.fountp2p.node.ensureNodeSeed
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.node.getP2PFeatures
import io.github.steve02081504.fountp2p.node.isNodeInitialized
import io.github.steve02081504.fountp2p.node.nodeDebug
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.random.Random

/** census 订阅标签数组（发布用）。 */
private val CENSUS_TAGS = listOf(listOf("t", CENSUS_TAG_FOUNT), listOf("x", CENSUS_TAG_X))

/** 发布/统计周期。 */
private const val CENSUS_INTERVAL_MS = 10L * 60_000

/** 冷启动初始包含概率。 */
private const val CENSUS_INITIAL_P = 0.5

/**
 * 用指定 seed 身份构建签名 census 包（nodeHash 由 seed 派生）。
 * @param seedHex 64 hex seed
 * @param p 包含概率
 * @param ts 时间戳（毫秒）
 * @return 签名包
 */
@JvmOverloads
fun buildCensusPacketFromSeed(seedHex: String, p: Any?, ts: Any? = System.currentTimeMillis().toDouble()): Map<String, Any?> {
	if (isHex64(seedHex) == null) throw IllegalArgumentException("p2p: census invalid seed")
	val pValue = (p as? Number)?.toDouble() ?: Double.NaN
	if (pValue.isNaN() || pValue.isInfinite() || pValue <= 0.0 || pValue > 1.0)
		throw IllegalArgumentException("p2p: census invalid p")
	val keyPair = keyPairFromSeed(hexToBytes(seedHex))
	val nodeHash = pubKeyHash(keyPair.publicKey)
	return linkedMapOf(
		"nodeHash" to nodeHash,
		"nodePubKey" to bytesToHex(keyPair.publicKey),
		"ts" to ts,
		"p" to pValue,
		"sig" to bytesToHex(sign(buildCensusMessage(ts, nodeHash, pValue), keyPair.secretKey)),
	)
}

private class CensusEvent(val p: Double, val at: Long)

/** 窗口事件：nodeHash → { p, at }（模块级）。 */
private val censusEvents = LinkedHashMap<String, CensusEvent>()

private fun noteCensusEvent(nodeHash: String, p: Double, at: Long = System.currentTimeMillis()) {
	val existing = censusEvents[nodeHash]
	if (existing != null && at < existing.at) return
	censusEvents[nodeHash] = CensusEvent(p, at)
}

private fun pruneCensusEvents(now: Long = System.currentTimeMillis(), ttlMs: Long = CENSUS_TTL_MS) {
	val iterator = censusEvents.entries.iterator()
	while (iterator.hasNext()) {
		val entry = iterator.next()
		if (now - entry.value.at > ttlMs) iterator.remove()
	}
}

private fun listCensusEvents(now: Long = System.currentTimeMillis(), ttlMs: Long = CENSUS_TTL_MS): List<CensusEvent> {
	pruneCensusEvents(now, ttlMs)
	return censusEvents.values.toList()
}

private fun selfCensusEvent(now: Long = System.currentTimeMillis(), ttlMs: Long = CENSUS_TTL_MS): CensusEvent? {
	val event = censusEvents[getNodeHash()] ?: return null
	return if (now - event.at <= ttlMs) event else null
}

/** 测试用：清空窗口。 */
fun resetCensusEvents() = censusEvents.clear()

/**
 * 当前在线节点数估计（HT：Σ 1/p 对端 + 1 自身）。
 * @param now 当前时间（毫秒）
 * @param ttlMs TTL
 * @return 估计与采样信息
 */
@JvmOverloads
fun getNodePopulationEstimate(now: Long = System.currentTimeMillis(), ttlMs: Long = CENSUS_TTL_MS): Map<String, Any?> {
	val events = listCensusEvents(now, ttlMs)
	val estimate = estimatePopulation(events.map { linkedMapOf<String, Any?>("p" to it.p, "at" to it.at.toDouble()) })
	var total = estimate.estimate
	if (isNodeInitialized() && getP2PFeatures()["census"] == true) {
		val selfEvent = selfCensusEvent(now, ttlMs)
		if (selfEvent != null) total -= 1 / selfEvent.p
		total++
	}
	return linkedMapOf(
		"estimate" to total,
		"sampleSize" to estimate.sampleSize.toDouble(),
		"eventsInWindow" to events.size.toDouble(),
	)
}

/** census worker 依赖（由 nostr provider 注入闭包）。 */
class NostrCensusDeps(
	val resolveRelayUrls: () -> List<String>,
	val publishEvent: suspend (List<String>, Map<String, Any?>, AbortSignalLike?) -> Unit,
	val signEvent: suspend (Int, List<List<String>>, String) -> Map<String, Any?>,
)

/**
 * census worker：每周期读 `features.census`，disabled 则跳过。
 * @param deps 依赖
 * @param now 当前时间（测试可注入）
 */
class NostrCensus(private val deps: NostrCensusDeps, private val now: () -> Long = { System.currentTimeMillis() }) {
	private var localP = CENSUS_INITIAL_P
	private var stopSubscription: () -> Unit = {}
	private var subscribed = false
	private var job: Job? = null
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
	private val signal = AbortSignalLike()

	private fun ensureSubscription() {
		if (subscribed) return
		subscribed = true
		stopSubscription = subscribeNostrKind(
			deps.resolveRelayUrls(),
			kind = NOSTR_CENSUS_KIND,
			rendezvousKey = CENSUS_TAG_FOUNT,
			tagX = CENSUS_TAG_X,
			onPayload = { bytes, _ ->
				val verified = verifyCensusBytes(bytes, now())
				if (verified != null) noteCensusEvent(verified.nodeHash, verified.p, verified.ts.toLong())
			},
		)
	}

	private suspend fun runOnce() {
		if (signal.aborted) return
		if (!isNodeInitialized() || getP2PFeatures()["census"] != true) return
		ensureSubscription()
		var observed = listCensusEvents(now()).size
		if (selfCensusEvent(now()) != null) observed--
		localP = nextInclusionProbability(localP, observed + 1, CENSUS_TARGET_EVENTS)
		if (Random.nextDouble() >= localP) return
		try {
			val packet = buildCensusPacketFromSeed(ensureNodeSeed(), localP, now())
			val content = bytesToBase64((Json.stringify(packet) ?: "null").toByteArray(Charsets.UTF_8))
			val event = deps.signEvent(NOSTR_CENSUS_KIND, CENSUS_TAGS, content)
			deps.publishEvent(deps.resolveRelayUrls(), event, signal)
			nodeDebug("p2p:census published", linkedMapOf("p" to localP))
		}
		catch (error: Exception) {
			nodeDebug("p2p:census publish fail", linkedMapOf("err" to (error.message ?: error.toString())))
		}
	}

	/** 启动 worker（立即跑一轮 + 每周期一轮）。 */
	fun start() {
		job = scope.launch {
			runCatching { runOnce() }
			while (true) {
				delay(CENSUS_INTERVAL_MS)
				runCatching { runOnce() }
			}
		}
	}

	/** 停止 worker 与订阅。 */
	fun stop() {
		signal.abort()
		job?.cancel()
		job = null
		stopSubscription()
		subscribed = false
	}
}

/**
 * 创建 census worker。
 * @param deps 依赖
 * @return worker 控制
 */
fun createNostrCensus(deps: NostrCensusDeps): NostrCensus = NostrCensus(deps)
