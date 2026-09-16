package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.deleteRecursively
import java.nio.file.Files

/**
 * 等价 JS `test/helpers/node.mjs` 的最小测试初始化：
 * 建临时 nodeDir → `initNode` → 关闭 census（避免公网）。
 *
 * 未移植的 nostr discovery / link registry 重置在 Kotlin 侧不存在，跳过。
 * @param prefix 临时目录前缀
 * @param block 测试体（参数为临时目录）
 */
internal suspend fun withTempNode(prefix: String, block: suspend (String) -> Unit) {
	val dir = Files.createTempDirectory(prefix)
	closeNode()
	initNode(NodeInitOptions(nodeDir = dir.toString()))
	setP2PFeatures(mapOf("census" to false))
	try {
		block(dir.toString())
	}
	finally {
		closeNode()
		deleteRecursively(dir)
	}
}
