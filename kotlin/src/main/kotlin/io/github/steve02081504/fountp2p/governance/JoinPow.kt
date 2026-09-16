package io.github.steve02081504.fountp2p.governance

import io.github.steve02081504.fountp2p.crypto.sha256Hex

/**
 * 无状态入群 PoW：绑定群近期 DAG tip/checkpoint root，任意 replica 可独立验证。
 */

/** 默认 epoch 窗口（1 小时） */
const val JOIN_POW_DEFAULT_EPOCH_MS: Double = 3_600_000.0

/** 默认 epoch 偏移容忍（±1 个 epoch） */
const val JOIN_POW_DEFAULT_EPOCH_SKEW: Double = 1.0

/**
 * `governance/tunables.json` 的等价默认值（数值统一为 [Double]）。
 */
val DEFAULT_ADMISSION_TUNABLES: Map<String, Any?> = linkedMapOf(
	"powFloorBits" to 18.0,
	"powVoluntaryBonusCap" to 0.12,
	"powVoluntaryBonusScaleBits" to 6.0,
	"powEpochMs" to 3600000.0,
	"powEpochSkew" to 1.0,
)

/**
 * @param fields preimage 字段
 * @param fields.groupId 群 ID
 * @param fields.anchorRef 近期 tip 或 checkpoint root
 * @param fields.joinerNodeHash 入群者 nodeHash
 * @param fields.epoch epoch 桶
 * @param fields.nonce 随机 nonce
 * @return SHA-256 十六进制
 */
fun computeJoinPowHash(fields: Map<String, Any?>): String {
	val preimage = "${fieldString(fields, "groupId")}:${fieldString(fields, "anchorRef")}:" +
		"${fieldString(fields, "joinerNodeHash")}:${fieldString(fields, "epoch")}:${fieldString(fields, "nonce")}"
	return sha256Hex(preimage)
}

/** JS 解构语义：缺失键为 `undefined`，`String(undefined) === "undefined"`。 */
private fun fieldString(fields: Map<String, Any?>, key: String): String =
	if (fields.containsKey(key)) jsString(fields[key]) else "undefined"

/**
 * @param hexHash SHA-256 十六进制
 * @param difficultyBits 前导零 bit 数
 * @return 是否满足难度
 */
fun joinPowHashMeetsDifficulty(hexHash: String, difficultyBits: Any?): Boolean {
	val bits = Math.max(0.0, Math.min(256.0, Math.floor(jsNumberOr(jsNumber(difficultyBits), 0.0))))
	if (bits <= 0.0) return true
	val neededHexChars = Math.ceil(bits / 4.0).toInt()
	if (hexHash.length < neededHexChars) return false
	for (i in 0 until neededHexChars) {
		val nibble = hexHash[i].digitToIntOrNull(16) ?: return false
		val nibbleBits = if (i < neededHexChars - 1) 4 else bits.toInt() - i * 4
		val mask = (0xF shl (4 - nibbleBits)) and 0xF
		if ((nibble and mask) != 0) return false
	}
	return true
}

/**
 * @param hexHash SHA-256 十六进制
 * @return 实际达成的前导零 bit 数 0..256
 */
fun countAchievedLeadingZeroBits(hexHash: String): Int {
	var bits = 0
	for (ch in hexHash) {
		val nibble = ch.digitToIntOrNull(16) ?: break
		if (nibble == 0) {
			bits += 4
			continue
		}
		for (b in 3 downTo 0) {
			if ((nibble and (1 shl b)) == 0) bits++
			else return bits
		}
	}
	return bits
}

/**
 * floor 以上自愿多做 bit 的 log 递减封顶信誉加成。
 * @param achievedBits 解实际达成 bit
 * @param floorBits 准入 floor
 * @param tunables admission tunables
 * @return 加成 0..cap
 */
fun powVoluntaryBonus(
	achievedBits: Any?,
	floorBits: Any?,
	tunables: Map<String, Any?> = DEFAULT_ADMISSION_TUNABLES,
): Double {
	val capRaw = tunables["powVoluntaryBonusCap"]
	val cap = if (isNullish(capRaw)) 0.0 else jsNumber(capRaw)
	val scaleRaw = tunables["powVoluntaryBonusScaleBits"]
	val scale = Math.max(1.0, if (isNullish(scaleRaw)) 6.0 else jsNumber(scaleRaw))
	if (!cap.isFinite() || cap <= 0.0) return 0.0
	val extra = Math.max(
		0.0,
		Math.floor(jsNumberOr(jsNumber(achievedBits), 0.0)) - Math.floor(jsNumberOr(jsNumber(floorBits), 0.0)),
	)
	if (extra <= 0.0) return 0.0
	return cap * (1 - Math.pow(2.0, -extra / scale))
}

/** `verifyJoinPow` 的校验结果与实际达成 bit。 */
data class JoinPowVerifyResult(val ok: Boolean, val achievedBits: Int) {
	/** @return JS 等价对象 `{ ok, achievedBits }` */
	fun toJson(): Map<String, Any?> = linkedMapOf("ok" to ok, "achievedBits" to achievedBits.toDouble())
}

/**
 * @param powSolution 客户端 solution
 * @param options 校验上下文
 * @param options.groupId 群 ID
 * @param options.senderNodeHash 签名者 nodeHash（须与 joiner 绑定）
 * @param options.knownAnchors 近期 tip / checkpoint root 列表
 * @param options.now 当前时间
 * @param options.difficultyBits 准入 floor（前导零 bit）
 * @param options.epochMs epoch 长度
 * @param options.epochSkew 允许 epoch 偏移
 * @return 校验结果与实际达成 bit
 */
fun verifyJoinPow(powSolution: Any?, options: Map<String, Any?>): JoinPowVerifyResult {
	val floorBits = Math.max(0.0, Math.floor(jsNumberOr(jsNumber(options["difficultyBits"]), 0.0)))
	if (floorBits <= 0.0) return JoinPowVerifyResult(true, 0)
	val solution = powSolution as? Map<*, *> ?: return JoinPowVerifyResult(false, 0)

	val anchorRefRaw = solution["anchorRef"]
	val anchorRef = if (isNullish(anchorRefRaw)) "" else jsString(anchorRefRaw)
	val nonceRaw = solution["nonce"]
	val epoch = jsNumber(solution["epoch"])
	val senderNodeHash = options["senderNodeHash"]
	val joinerRaw = solution["joinerNodeHash"]
	val joinerNodeHash: Any? = if (isNullish(joinerRaw)) senderNodeHash else joinerRaw

	if (anchorRef.isEmpty() || isNullish(nonceRaw) || !epoch.isFinite()) return JoinPowVerifyResult(false, 0)
	if (!jsTruthy(joinerNodeHash) || joinerNodeHash != senderNodeHash) return JoinPowVerifyResult(false, 0)

	val anchors = (options["knownAnchors"] as? List<*>).orEmpty().filter { jsTruthy(it) }
	if (anchors.isEmpty() || anchorRef !in anchors) return JoinPowVerifyResult(false, 0)

	val epochMs = Math.max(60000.0, jsNumberOr(jsNumber(options["epochMs"]), JOIN_POW_DEFAULT_EPOCH_MS))
	val skewRaw = options["epochSkew"]
	val skew = Math.max(0.0, Math.floor(if (isNullish(skewRaw)) JOIN_POW_DEFAULT_EPOCH_SKEW else jsNumber(skewRaw)))
	val nowRaw = options["now"]
	val now = if (isNullish(nowRaw)) System.currentTimeMillis().toDouble() else jsNumber(nowRaw)
	val nowEpoch = Math.floor(now / epochMs)
	if (Math.abs(epoch - nowEpoch) > skew) return JoinPowVerifyResult(false, 0)

	val hash = computeJoinPowHash(
		linkedMapOf(
			"groupId" to options["groupId"],
			"anchorRef" to anchorRef,
			"joinerNodeHash" to joinerNodeHash,
			"epoch" to epoch,
			"nonce" to jsString(nonceRaw),
		),
	)
	val achievedBits = countAchievedLeadingZeroBits(hash)
	return JoinPowVerifyResult(joinPowHashMeetsDifficulty(hash, floorBits), achievedBits)
}

/**
 * 浏览器/Node 通用求解（同步 brute-force，适合低难度）。
 * @param fields preimage 字段（不含 nonce）
 * @param floorBits 准入 floor（前导零 bit）
 * @param maxAttempts 最大尝试次数
 * @param targetBits 目标 bit（省略则等于 floor）
 * @return solution；未找到达标解时为 null
 */
fun solveJoinPow(
	fields: Map<String, Any?>,
	floorBits: Any?,
	maxAttempts: Int = 5_000_000,
	targetBits: Any? = null,
): Map<String, Any?>? {
	val floor = Math.max(1.0, Math.floor(jsNumberOr(jsNumber(floorBits), 1.0)))
	val target = Math.max(floor, Math.floor(jsNumberOr(jsNumber(targetBits), floor)))
	var best: Map<String, Any?>? = null
	var bestAchieved = 0
	for (nonce in 0 until maxAttempts) {
		val nonceText = nonce.toString()
		val hashFields = LinkedHashMap(fields)
		hashFields["nonce"] = nonceText
		val hash = computeJoinPowHash(hashFields)
		val achieved = countAchievedLeadingZeroBits(hash)
		if (achieved.toDouble() >= floor) {
			val solution = LinkedHashMap(fields)
			solution["nonce"] = nonceText
			solution["achievedBits"] = achieved.toDouble()
			if (achieved.toDouble() >= target) return solution
			if (best == null || achieved > bestAchieved) {
				best = solution
				bestAchieved = achieved
			}
		}
	}
	return best
}

/**
 * @param difficultyBits 难度 bit
 * @return 期望哈希次数（2^bits）
 */
fun expectedJoinPowHashes(difficultyBits: Any?): Double {
	val bits = Math.max(0.0, Math.floor(jsNumberOr(jsNumber(difficultyBits), 0.0)))
	return if (bits <= 52.0) Math.pow(2.0, bits) else 9007199254740991.0
}
