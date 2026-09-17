package io.github.steve02081504.fountp2p.transport

/**
 * `transport/tunables.json` 的等价默认值（数值统一为 [Double]，键序同 JSON）。
 *
 * 偏离：JS `loadTransportTunables` 从磁盘读取并进程内缓存；Kotlin 侧沿用本仓库
 * 约定内联默认值（无文件 I/O），返回同一缓存实例。
 */
val DEFAULT_TRANSPORT_TUNABLES: Map<String, Any?> = linkedMapOf(
	"meshKeepaliveIntervalMs" to 60000.0,
	"meshScanLimit" to 64.0,
	"meshPromoteStableMs" to 1800000.0,
	"meshN" to 8.0,
	"meshKMax" to 5.0,
	"meshNLow" to 4.0,
	"meshKMaxLow" to 2.0,
	"groupMemberScanIntervalMs" to 30000.0,
	"groupMemberScanLimit" to 64.0,
	"maxSignalSessions" to 256.0,
)

private var transportTunablesCache: Map<String, Any?>? = null

/**
 * @return transport tunables（进程内缓存）
 */
fun loadTransportTunables(): Map<String, Any?> {
	val cached = transportTunablesCache
	if (cached != null) return cached
	val loaded = LinkedHashMap(DEFAULT_TRANSPORT_TUNABLES)
	transportTunablesCache = loaded
	return loaded
}
