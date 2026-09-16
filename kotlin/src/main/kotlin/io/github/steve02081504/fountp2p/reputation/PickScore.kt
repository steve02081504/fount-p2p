package io.github.steve02081504.fountp2p.reputation

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined

/**
 * 纯函数：从已加载的 reputation 文件体计算节点全局分（无 setting_loader 依赖）。
 * @param repFile reputation.json 内容
 * @param nodeId 64 位十六进制 节点
 * @return 信誉分
 */
fun pickNodeScoreFromReputation(repFile: Any?, nodeId: String): Double {
	val row = Json.at(Json.at(repFile, "byNodeHash"), nodeId)
	if (!jsTruthy(row)) return 0.0
	val score = Json.at(row, "score")
	return if (score == null || score === JsonUndefined) 0.0 else jsNumberValue(score)
}
