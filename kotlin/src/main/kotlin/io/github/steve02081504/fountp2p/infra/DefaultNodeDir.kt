package io.github.steve02081504.fountp2p.infra

import java.nio.file.Paths

/**
 * @return 平台默认 node 数据目录
 */
fun defaultNodeDir(): String {
	val osName = System.getProperty("os.name").orEmpty().lowercase()
	return if (osName.contains("win")) {
		val base = System.getenv("LOCALAPPDATA")
			?: Paths.get(System.getProperty("user.home"), "AppData", "Local").toString()
		Paths.get(base, "fount-p2p", "node").toString()
	}
	else {
		Paths.get(System.getProperty("user.home"), ".local", "share", "fount-p2p", "node").toString()
	}
}

/**
 * @param override CLI 或调用方覆盖
 * @return 解析后的绝对 node 目录
 */
fun resolveNodeDir(override: String?): String {
	val value = override ?: ""
	return if (value.isNotEmpty()) Paths.get(value).toAbsolutePath().normalize().toString() else defaultNodeDir()
}
