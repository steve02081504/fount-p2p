package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsNumberOr
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Trystero/WebRTC 连接预算（进程内）+ 单源槽位配额与 trusted 保留。
 *
 * 等价 `js/transport/rtc_connection_budget.mjs`；缺省参数用 `Number(x) || 默认` 语义。
 */

/** 单来源最多占用的非 trusted 槽位比例 */
const val MAX_SOURCE_SLOT_FRACTION: Double = 0.25

/** 默认 trusted 保留比例 */
private const val DEFAULT_TRUSTED_RESERVE_FRACTION: Double = 0.25

/** 默认 trusted 绝对保留槽位 */
private const val DEFAULT_MIN_TRUSTED_RESERVED: Double = 3.0

/** 生效的 RTC 限额。 */
data class RtcBudgetLimits(
	val maxActive: Double,
	val maxJoinsPerMin: Double,
	val overloadCooldownMs: Double,
	val trustedPeers: List<String>,
	val trustedReserveFraction: Double,
	val minTrustedReserved: Double,
)

/** @return 当前毫秒时间戳（等价 JS `Date.now()`）。 */
private fun now(): Double = System.currentTimeMillis().toDouble()

/**
 * @param limits 限额
 * @return 生效限额
 */
fun resolveRtcBudgetLimits(limits: Map<String, Any?> = emptyMap()): RtcBudgetLimits {
	val trustedPeersRaw = limits["trustedPeers"]
	val trustedPeers = (trustedPeersRaw as? List<*>)?.filterIsInstance<String>() ?: emptyList()
	return RtcBudgetLimits(
		maxActive = max(4.0, min(128.0, jsNumberOr(jsNumber(limits["maxActive"]), 32.0))),
		maxJoinsPerMin = max(1.0, min(120.0, jsNumberOr(jsNumber(limits["maxJoinsPerMin"]), 12.0))),
		overloadCooldownMs = max(1000.0, jsNumberOr(jsNumber(limits["overloadCooldownMs"]), 15_000.0)),
		trustedPeers = trustedPeers,
		trustedReserveFraction = max(
			0.1,
			min(0.5, jsNumberOr(jsNumber(limits["trustedReserveFraction"]), DEFAULT_TRUSTED_RESERVE_FRACTION)),
		),
		minTrustedReserved = max(1.0, floor(jsNumberOr(jsNumber(limits["minTrustedReserved"]), DEFAULT_MIN_TRUSTED_RESERVED))),
	)
}

private class RtcBucket {
	val active = LinkedHashSet<String>()
	var joinTimestamps = ArrayList<Double>()
	var overloadUntil = 0.0
	val sourceByPeer = LinkedHashMap<String, String>()
	val trustedPeers = LinkedHashSet<String>()
	val peerNodeHash = LinkedHashMap<String, String>()
}

private val budgets = LinkedHashMap<String, RtcBucket>()

/**
 * @param roomKey 房间键
 * @param limits RTC 限额
 * @return 桶
 */
private fun bucketFor(roomKey: String, limits: Map<String, Any?> = emptyMap()): RtcBucket {
	var bucket = budgets[roomKey]
	if (bucket == null) {
		bucket = RtcBucket()
		bucket.trustedPeers.addAll(resolveRtcBudgetLimits(limits).trustedPeers)
		budgets[roomKey] = bucket
	}
	for (id in resolveRtcBudgetLimits(limits).trustedPeers)
		bucket.trustedPeers.add(id)
	return bucket
}

/**
 * @param roomKey 房间键
 * @param limits 限额
 * @return 是否处于过载冷却
 */
fun isRtcRoomOverloaded(roomKey: String, limits: Map<String, Any?> = emptyMap()): Boolean {
	val bucket = bucketFor(roomKey, limits)
	return now() < bucket.overloadUntil
}

/**
 * @param roomKey 房间键
 * @param peerId 对等端 id
 * @param limits 限额
 * @param sourceId 来源标识（用于单源配额）
 * @return 是否允许新 join/握手
 */
fun takeRtcJoinSlot(
	roomKey: String,
	peerId: String?,
	limits: Map<String, Any?> = emptyMap(),
	sourceId: String = "peer",
): Boolean {
	val resolved = resolveRtcBudgetLimits(limits)
	val bucket = bucketFor(roomKey, limits)
	val now = now()
	if (now < bucket.overloadUntil) return false
	bucket.joinTimestamps = ArrayList(bucket.joinTimestamps.filter { now - it < 60_000.0 })
	if (bucket.joinTimestamps.size.toDouble() >= resolved.maxJoinsPerMin) {
		bucket.overloadUntil = now + resolved.overloadCooldownMs
		return false
	}
	if (!peerId.isNullOrEmpty() && bucket.active.contains(peerId)) return true

	val isTrusted = !peerId.isNullOrEmpty() && bucket.trustedPeers.contains(peerId)
	val trustedReserved = max(resolved.minTrustedReserved, floor(resolved.maxActive * resolved.trustedReserveFraction))
	val maxNonTrusted = max(1.0, resolved.maxActive - trustedReserved)
	var nonTrustedCount = 0
	for (id in bucket.active)
		if (!bucket.trustedPeers.contains(id)) nonTrustedCount++
	if (!isTrusted) {
		val source = sourceId.ifEmpty { "peer" }
		var sameSource = 0
		for (peerSource in bucket.sourceByPeer.values)
			if (peerSource == source) sameSource++
		val sourceCap = max(1.0, floor(resolved.maxActive * MAX_SOURCE_SLOT_FRACTION))
		if (sameSource.toDouble() >= sourceCap) return false
		if (nonTrustedCount.toDouble() >= maxNonTrusted && bucket.active.size.toDouble() >= resolved.maxActive) {
			bucket.overloadUntil = now + resolved.overloadCooldownMs
			return false
		}
	}

	if (bucket.active.size.toDouble() >= resolved.maxActive && !isTrusted) {
		bucket.overloadUntil = now + resolved.overloadCooldownMs
		return false
	}
	bucket.joinTimestamps.add(now)
	if (!peerId.isNullOrEmpty()) {
		bucket.active.add(peerId)
		bucket.sourceByPeer[peerId] = sourceId.ifEmpty { "peer" }
	}
	return true
}

/**
 * @param roomKey 房间键
 * @param peerId Trystero 对端 id
 * @param nodeHash 对等 nodeHash
 * @param limits 限额（含 trustedPeers nodeHash 列表）
 */
fun annotateRtcPeerNodeHash(roomKey: String, peerId: String?, nodeHash: String?, limits: Map<String, Any?> = emptyMap()) {
	val bucket = budgets[roomKey] ?: return
	if (peerId.isNullOrEmpty() || nodeHash.isNullOrEmpty()) return
	bucket.peerNodeHash[peerId] = nodeHash
	for (trusted in resolveRtcBudgetLimits(limits).trustedPeers)
		if (trusted == nodeHash)
			bucket.trustedPeers.add(peerId)
}

/**
 * @param roomKey 房间键
 * @param peerId Trystero 对端 id
 * @param sourceId 来源标识（PEX hint source / explore 源）
 */
fun setRtcPeerSource(roomKey: String, peerId: String?, sourceId: String?) {
	val bucket = budgets[roomKey] ?: return
	if (peerId.isNullOrEmpty()) return
	bucket.sourceByPeer[peerId] = sourceId?.ifEmpty { "peer" } ?: "peer"
}

/**
 * @param roomKey 房间键
 * @param peerId 对等端 id
 */
fun releaseRtcPeer(roomKey: String, peerId: String?) {
	val bucket = budgets[roomKey] ?: return
	if (peerId.isNullOrEmpty()) return
	bucket.active.remove(peerId)
	bucket.sourceByPeer.remove(peerId)
	bucket.peerNodeHash.remove(peerId)
	// 房间空闲后丢掉桶，避免 leave 过的 roomKey 永久占内存
	if (bucket.active.isEmpty()) budgets.remove(roomKey)
}

/** @return 房间桶数（测试用） */
fun rtcBudgetRoomCount(): Int = budgets.size

/** RTC 过载时跳过的非关键联邦 action */
private val NON_CRITICAL_FED_ACTIONS = setOf(
	"fed_pex",
	"fed_partition_bridge",
	"fed_chunk_put",
	"fed_chunk_get",
	"fed_chunk_data",
	"fed_chunk_ack",
	"fed_manifest_get",
	"fed_manifest_data",
	"part_invoke",
	"part_query_req",
	"part_query_res",
	"discovery_announce",
	"discovery_query",
	"char_rpc",
	"fed_volatile",
	"fed_tip_ping",
	"fed_archive_digest_obs",
)

/**
 * @param roomKey 房间键
 * @param actionName Trystero 动作
 * @param limits 限额
 * @return 是否允许处理/发送该 action
 */
fun isFederationActionAllowedUnderLoad(roomKey: String, actionName: String, limits: Map<String, Any?> = emptyMap()): Boolean {
	if (!isRtcRoomOverloaded(roomKey, limits)) return true
	return actionName !in NON_CRITICAL_FED_ACTIONS
}
