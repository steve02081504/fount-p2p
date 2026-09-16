package io.github.steve02081504.fountp2p.reputation

/**
 * `reputation/tunables.json` 的等价默认值。
 *
 * JS 侧 tunables 是普通 JSON 对象，函数通过属性名读取并带兜底；Kotlin 侧沿用
 * 本仓库 `schemas/PartQuery.kt` 的约定，用 `Map<String, Any?>` 承载，键与
 * `tunables.json` 完全一致，数值统一为 [Double]。
 */
val DEFAULT_REPUTATION_TUNABLES: Map<String, Any?> = linkedMapOf(
	"wantUnknownWindowMs" to 300000.0,
	"wantUnknownThreshold" to 3.0,
	"penaltyUnknownWant" to 0.12,
	"penaltyMessageRate" to 0.15,
	"chunkStoreRepBump" to 0.03,
	"chunkFetchFailPenalty" to 0.08,
	"archiveServeMismatchPenalty" to 0.08,
	"relayRepBump" to 0.02,
	"defaultSlashAlertTtlMs" to 86400000.0,
	"maxRelayBumpSeen" to 2000.0,
	"relayBumpDedupeMs" to 86400000.0,
	"collusionLambda" to 0.07,
	"collusionDelta" to 0.62,
	"collusionMaxHop" to 6.0,
	"slashVerifiedMultiplier" to 0.5,
	"slashDefaultClaim" to 0.2,
	"slashVerifiedDefaultClaim" to 0.35,
	"slashUnverifiedDefaultClaim" to 0.2,
	"introducerSeedEdge" to 0.5,
	"recidivismMultiplierStep" to 0.25,
	"recidivismMax" to 3.0,
	"redemptionCreditPerStreakLevel" to 0.08,
	"inviteRedemptionCreditPerBad" to 0.15,
	"inviteBadEscalationStep" to 0.5,
	"inviteBadEscalationMax" to 4.0,
	"inviteHopBonusEvery" to 2.0,
	"inviteHopBonusMax" to 4.0,
	"inviteDeltaBoostPerBad" to 0.05,
	"inviteDeltaBoostMax" to 0.3,
	"baselineAlpha" to 0.08,
	"anomalyZThreshold" to 2.8,
	"quarantineTtlMs" to 900000.0,
	"quarantineTrustDamp" to 0.35,
	"baselineMinSamples" to 6.0,
)

/**
 * JS `defaultReputationTunables()`：返回默认 reputation tunables。
 *
 * JS 返回的是同一引用（注释写「副本」但实现直接返回），Kotlin 侧返回同一不可变
 * 默认表即可；需要覆写时调用方自行拷贝。
 * @return 默认 reputation tunables
 */
fun defaultReputationTunables(): Map<String, Any?> = DEFAULT_REPUTATION_TUNABLES
