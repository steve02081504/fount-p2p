package io.github.steve02081504.fountp2p.reputation

/**
 * 测试辅助：构造信誉表并访问其中的行。
 */

/** @return 空信誉表。 */
fun newRepFile(): MutableMap<String, Any?> = ensureReputationShape(
	linkedMapOf<String, Any?>("byNodeHash" to LinkedHashMap<String, Any?>()),
)

/** @return `byNodeHash`（可变）。 */
@Suppress("UNCHECKED_CAST")
fun repRows(data: Map<String, Any?>): MutableMap<String, Any?> = data["byNodeHash"] as MutableMap<String, Any?>

/** @return 指定节点的行（可变）。 */
@Suppress("UNCHECKED_CAST")
fun repRow(data: Map<String, Any?>, nodeId: String): MutableMap<String, Any?> = repRows(data)[nodeId] as MutableMap<String, Any?>

/** @return 指定节点的 `score`。 */
fun rowScore(data: Map<String, Any?>, nodeId: String): Double = repRow(data, nodeId)["score"] as Double
