package io.github.steve02081504.fountp2p.registries

/**
 * shell 逻辑名 → partpath 注册表（`registries/part_path.mjs` 的等价实现）。
 */

/** shell 逻辑名 → partpath。 */
private val shellPartpaths = LinkedHashMap<String, String>()

/**
 * Shell Load 时注册本 part 的 partpath（P2P 层不硬编码 shells/ 下的路径）。
 * @param shellKey 如 social、chat
 * @param partpath 如 shells/social
 */
fun registerShellPartpath(shellKey: String, partpath: String) {
	shellPartpaths[shellKey] = partpath
}

/**
 * @param shellKey 如 social、chat
 */
fun unregisterShellPartpath(shellKey: String) {
	shellPartpaths.remove(shellKey)
}

/**
 * @param shellKey 如 social
 * @return 已注册的 partpath
 */
fun getShellPartpath(shellKey: String): String =
	shellPartpaths[shellKey] ?: throw IllegalStateException("shell partpath not registered: $shellKey")
