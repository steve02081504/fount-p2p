package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.assertSafeEvfsLogicalPath
import io.github.steve02081504.fountp2p.core.isEntityHash128
import java.net.URI

/**
 * EVFS URI 引用编解码（等价 `files/evfs_ref.mjs`）。
 */

/** evfs URI scheme */
const val EVFS_SCHEME: String = "evfs:"

/**
 * @param entityHash 128 位十六进制
 * @param logicalPath EVFS 路径
 * @return evfs URI 引用
 */
fun formatEvfsRef(entityHash: String, logicalPath: String): String {
	val safePath = assertSafeEvfsLogicalPath(logicalPath)
	return "$EVFS_SCHEME//$entityHash/$safePath"
}

/**
 * @param ref evfs URI
 * @return 解析结果；非法为 null
 */
fun parseEvfsRef(ref: Any?): Map<String, Any?>? {
	if (ref !is String || !ref.startsWith(EVFS_SCHEME)) return null
	return try {
		val url = URI(ref)
		if (url.scheme != "evfs") return null
		val entityHash = url.host
		val logicalPath = (url.path ?: "").replace(Regex("^/+"), "")
		if (isEntityHash128(entityHash) == null) return null
		linkedMapOf(
			"entityHash" to entityHash,
			"logicalPath" to assertSafeEvfsLogicalPath(logicalPath),
		)
	}
	catch (_: Throwable) {
		null
	}
}
