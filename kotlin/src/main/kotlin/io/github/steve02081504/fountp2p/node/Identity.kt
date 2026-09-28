package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.entityHashFromRecoveryPubKeyHex
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.parseEntityHash
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.mailbox.normalizeMailboxSettings
import io.github.steve02081504.fountp2p.core.Json

/**
 * 节点身份与传输配置（`js/node/identity.mjs` 的等价实现）。
 *
 * 持久化于 `nodeDir/node.json`：`nodeSeedHex` / `relayUrls` / `batterySaver` / `mailbox`。
 */

private const val NODE_JSON = "node"

/**
 * Node `Buffer.from(hex, 'hex')` 等价：逐对解析 hex，遇到非法对即停止，丢弃末尾单字符。
 * @param hex hex 文本
 * @return 解码字节
 */
private fun nodeHexDecode(hex: String): ByteArray {
	val out = ArrayList<Byte>(hex.length / 2)
	var index = 0
	while (index + 1 < hex.length) {
		val high = nodeNibble(hex[index])
		val low = nodeNibble(hex[index + 1])
		if (high < 0 || low < 0) break
		out.add(((high shl 4) or low).toByte())
		index += 2
	}
	return out.toByteArray()
}

/** @param char hex 字符 @return nibble 值；非法为 -1 */
private fun nodeNibble(char: Char): Int = when (char) {
	in '0'..'9' -> char - '0'
	in 'a'..'f' -> char - 'a' + 10
	in 'A'..'F' -> char - 'A' + 10
	else -> -1
}

/**
 * 由持久化 nodeSeed 派生 nodeHash（64 hex）。
 * @param seedHex 32 字节 hex
 * @return 节点哈希
 */
fun nodeHashFromSeed(seedHex: String): String {
	val seed = nodeHexDecode(seedHex)
	if (seed.size != 32) throw IllegalArgumentException("invalid node seed")
	val keyPair = keyPairFromSeed(seed)
	return pubKeyHash(keyPair.publicKey)
}

/** @return 节点配置磁盘对象（可变的 LinkedHashMap；缺失/非法时为 {}） */
private fun loadNodeFile(): MutableMap<String, Any?> {
	val raw = readNodeJsonSync(NODE_JSON)
	if (raw is Map<*, *> && raw.keys.all { it is String }) {
		val out = LinkedHashMap<String, Any?>()
		for ((key, value) in raw) out[key as String] = value
		return out
	}
	return LinkedHashMap()
}

/**
 * @param patch 部分字段
 * @return 合并后写盘
 */
private fun saveNodeFile(patch: Map<String, Any?>): MutableMap<String, Any?> {
	val data = loadNodeFile()
	data.putAll(patch)
	writeNodeJsonSync(NODE_JSON, data)
	emitNodeChange("node-config-changed", linkedMapOf("patch" to patch))
	return data
}

/**
 * 确保本地节点 seed 已持久化并返回。
 * 只依赖本地存储目录（`configureNodeStorage` 或 `initNode` 提供），不要求运行中的节点。
 * @return 64 位十六进制 节点种子
 */
fun ensureNodeSeed(): String {
	val data = loadNodeFile()
	val existing = isHex64(data["nodeSeedHex"])
	if (existing != null) return existing
	val nodeSeedHex = bytesToHex(randomBytes(32))
	saveNodeFile(mapOf("nodeSeedHex" to nodeSeedHex))
	return nodeSeedHex
}

/**
 * 由本地 seed 派生本节点 nodeHash。
 * 只依赖本地存储目录，不要求运行中的节点。
 * @return 本节点 64 hex nodeHash
 */
fun getNodeHash(): String = nodeHashFromSeed(ensureNodeSeed())

/**
 * @return 传输与 mailbox 配置 `{ relayUrls, batterySaver, mailbox }`
 */
fun getNodeTransportSettings(): Map<String, Any?> {
	val data = loadNodeFile()
	val relayUrls = (Json.arr(data["relayUrls"]) ?: emptyList())
		.map { if (jsTruthy(it)) jsString(it) else "" }
		.filter { it.startsWith("wss://") }
	val batterySaver = jsTruthy(data["batterySaver"])
	val mailbox = normalizeMailboxSettings(Json.obj(data["mailbox"]))
	return linkedMapOf(
		"relayUrls" to relayUrls,
		"batterySaver" to batterySaver,
		"mailbox" to mailbox,
	)
}

/**
 * @param patch 部分字段
 * @return 保存后的传输配置
 */
fun saveNodeTransportSettings(patch: Map<String, Any?>): Map<String, Any?> {
	val data = loadNodeFile()
	val patchBattery = patch["batterySaver"]
	if (patchBattery != null && patchBattery !== io.github.steve02081504.fountp2p.core.JsonUndefined)
		data["batterySaver"] = jsTruthy(patchBattery)
	val patchRelayUrls = patch["relayUrls"]
	if (jsTruthy(patchRelayUrls))
		data["relayUrls"] = (Json.arr(patchRelayUrls) ?: emptyList())
			.map { if (jsTruthy(it)) jsString(it) else "" }
			.filter { it.startsWith("wss://") }
	val patchMailbox = patch["mailbox"]
	if (jsTruthy(patchMailbox)) {
		val merged = LinkedHashMap<String, Any?>()
		Json.obj(data["mailbox"])?.let { merged.putAll(it) }
		Json.obj(patchMailbox)?.let { merged.putAll(it) }
		data["mailbox"] = normalizeMailboxSettings(merged)
	}
	saveNodeFile(data)
	return getNodeTransportSettings()
}

/**
 * 确保 node.json 存在且含 nodeSeed、mailbox 默认值。
 * @return 默认配置与 nodeHash `{ relayUrls, batterySaver, mailbox, nodeHash }`
 */
fun ensureNodeDefaults(): Map<String, Any?> {
	ensureNodeSeed()
	val data = loadNodeFile()
	if (!jsTruthy(data["mailbox"])) saveNodeFile(mapOf("mailbox" to normalizeMailboxSettings()))
	val out = LinkedHashMap<String, Any?>(getNodeTransportSettings())
	out["nodeHash"] = getNodeHash()
	return out
}

/**
 * @param nodeHash 64 位十六进制
 * @param recoveryPubKeyHex 64 位十六进制 recovery 公钥（稳定身份锚）
 * @return entityHash（非法 hex 时 null）
 */
fun entityHashFromKeys(nodeHash: Any?, recoveryPubKeyHex: Any?): String? {
	val pub = isHex64(recoveryPubKeyHex)
	val node = isHex64(nodeHash)
	if (node == null || pub == null) return null
	return entityHashFromRecoveryPubKeyHex(node, pub)
}

/**
 * 由本地 nodeHash 与 recovery 公钥派生本节点 entityHash。
 * 只依赖本地存储目录，不要求运行中的节点（联邦未启动时也可创建本地身份）。
 * @param recoveryPubKeyHex 64 位十六进制 recovery 公钥
 * @return 本节点 entityHash
 */
fun resolveLocalEntityHashFromRecoveryPubKeyHex(recoveryPubKeyHex: Any?): String? =
	entityHashFromKeys(getNodeHash(), recoveryPubKeyHex)

/**
 * @param entityHash 目标 entityHash
 * @return 是否为本节点可写实体
 */
fun isWritableLocalEntity(entityHash: Any?): Boolean {
	val parsed = parseEntityHash(entityHash) ?: return false
	return parsed.nodeHash == getNodeHash()
}
