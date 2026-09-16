package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.utils.readJsonFileSync
import io.github.steve02081504.fountp2p.utils.writeJsonFileSync
import java.nio.file.Paths

/**
 * 节点目录下 JSON 配置读写（等价 `node/storage.mjs`）。
 * 路径布局：`nodeDir/<name>.json`、`nodeDir/nostr/relays.json`。
 */

/**
 * @param name 不含扩展名的配置文件名
 * @return 绝对路径
 */
fun nodeJsonPath(name: String): String = Paths.get(getNodeDir(), "$name.json").toString()

/**
 * @param name 配置文件名
 * @return 解析后的 JSON 或 null
 */
fun readNodeJsonSync(name: String): Any? = readJsonFileSync(nodeJsonPath(name))

/**
 * @param name 配置文件名
 * @param data 数据
 */
fun writeNodeJsonSync(name: String, data: Any?) {
	writeJsonFileSync(nodeJsonPath(name), data)
}

/**
 * Nostr relay 池 / peer 路由持久化文件路径（`nodeDir/nostr/relays.json`）。
 * @return 绝对路径
 */
fun nostrRelayJsonPath(): String = Paths.get(getNodeDir(), "nostr", "relays.json").toString()

/** @return 解析后的 Nostr relay JSON 或 null */
fun readNostrRelaysJsonSync(): Any? = readJsonFileSync(nostrRelayJsonPath())

/** @param data 数据 */
fun writeNostrRelaysJsonSync(data: Any?) {
	writeJsonFileSync(nostrRelayJsonPath(), data)
}
