package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.parseEntityHash
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.node.readNodeJsonSync
import io.github.steve02081504.fountp2p.node.writeNodeJsonSync
import io.github.steve02081504.fountp2p.core.hexToBytes

/**
 * `node/identity.mjs` 中 `files/` 依赖的最小身份子集。
 *
 * `node/PersonalBlock.kt` 已有同语义实现但为 `private`；为不跨包修改，这里在
 * `files` 包内按 JS 原文复刻（`getNodeHash` / `nodeHashFromSeed` / `isWritableLocalEntity`）。
 */

/**
 * @param seedHex 32 字节 hex
 * @return 节点哈希
 */
fun nodeHashFromSeed(seedHex: String): String {
	val seed = hexToBytes(seedHex)
	if (seed.size != 32) throw IllegalArgumentException("invalid node seed")
	val keyPair = keyPairFromSeed(seed)
	return pubKeyHash(keyPair.publicKey)
}

/** @return 64 位十六进制 节点种子（缺失时生成并落盘） */
fun ensureNodeSeed(): String {
	val data = readNodeJsonSync("node") as? Map<*, *> ?: emptyMap<Any?, Any?>()
	val existing = isHex64(data["nodeSeedHex"])
	if (existing != null) return existing
	val nodeSeedHex = bytesToHex(randomBytes(32))
	val merged = LinkedHashMap<String, Any?>()
	for ((key, value) in data) if (key is String) merged[key] = value
	merged["nodeSeedHex"] = nodeSeedHex
	writeNodeJsonSync("node", merged)
	return nodeSeedHex
}

/** @return 本节点 64 hex nodeHash */
fun getNodeHash(): String = nodeHashFromSeed(ensureNodeSeed())

/** @param entityHash 目标 entityHash @return 是否为本节点可写实体 */
fun isWritableLocalEntity(entityHash: Any?): Boolean {
	val parsed = parseEntityHash(entityHash) ?: return false
	return parsed.nodeHash == getNodeHash()
}
