package io.github.steve02081504.fountp2p.core

import java.util.UUID

/**
 * @param prefix ID 前缀（如 channel_）
 * @return 带前缀的随机 ID
 */
fun prefixedRandomId(prefix: String): String = prefix + UUID.randomUUID().toString().replace("-", "")
