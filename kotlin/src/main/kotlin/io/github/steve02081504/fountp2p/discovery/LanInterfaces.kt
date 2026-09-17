package io.github.steve02081504.fountp2p.discovery

import java.net.Inet4Address
import java.net.NetworkInterface

/** advert / 组播 beacon 携带的 LAN IPv4 上限 */
const val MAX_LAN_HOSTS = 4

/** 单个网卡地址项（等价 `os.networkInterfaces()` 中的 `{ internal, family, address }`）。 */
data class LanInterfaceAddress(val internal: Boolean, val family: Any?, val address: String)

/**
 * 网卡枚举抽象（Android/JVM 无 `node:os`；由宿主注入）。
 */
interface LanInterfaceProvider {
	/** @return 全部网卡地址 */
	fun listAddresses(): List<LanInterfaceAddress>
}

/** 默认 JVM 实现（`java.net.NetworkInterface`）。 */
object DefaultLanInterfaceProvider : LanInterfaceProvider {
	override fun listAddresses(): List<LanInterfaceAddress> {
		val out = ArrayList<LanInterfaceAddress>()
		try {
			for (iface in NetworkInterface.getNetworkInterfaces()) {
				if (iface == null) continue
				val isLoopback = try {
					iface.isLoopback
				}
				catch (_: Exception) {
					false
				}
				for (addr in iface.inetAddresses) {
					val family = if (addr is Inet4Address) "IPv4" else "IPv6"
					out.add(LanInterfaceAddress(isLoopback, family, addr.hostAddress ?: ""))
				}
			}
		}
		catch (_: Exception) {
			// 与 JS 异常路径一致：返回已收集部分
		}
		return out
	}
}

private var lanInterfaceProvider: LanInterfaceProvider = DefaultLanInterfaceProvider

/**
 * 注入网卡枚举实现（Android 端可换成 ConnectivityManager 包装）。
 * @param provider 网卡枚举实现
 */
fun setLanInterfaceProvider(provider: LanInterfaceProvider) {
	lanInterfaceProvider = provider
}

/**
 * 私网 / 链路本地 IPv4（RFC1918 + 169.254/16）。
 * @param host 候选 IPv4
 * @return 是否允许作为可拨号 LAN hint
 */
private fun isPrivateLanIpv4(host: String): Boolean {
	val parts = host.split(".")
	if (parts.size != 4) return false
	val octets = parts.map { it.toIntOrNull() }
	if (octets.any { it == null || it < 0 || it > 255 }) return false
	val a = octets[0]!!
	val b = octets[1]!!
	if (a == 10) return true
	if (a == 172 && b in 16..31) return true
	if (a == 192 && b == 168) return true
	if (a == 169 && b == 254) return true
	return false
}

/**
 * untrusted ingress：清洗 advert body 中的 LAN IPv4 列表。
 * @param input 原始 lanHosts
 * @return 去重后的私网/链路本地 IPv4 列表
 */
fun normalizeLanHosts(input: Any?): List<String> {
	if (input == null || input === io.github.steve02081504.fountp2p.core.JsonUndefined) return emptyList()
	val arr = if (input is List<*>) input else listOf(input)
	val seen = HashSet<String>()
	val out = ArrayList<String>()
	for (item in arr) {
		val host = item?.toString() ?: ""
		if (host.isEmpty() || !isPrivateLanIpv4(host) || seen.contains(host)) continue
		seen.add(host)
		out.add(host)
		if (out.size >= MAX_LAN_HOSTS) break
	}
	return out
}

/**
 * @param addr IPv4
 * @return 排序权重（越小越优先）
 */
private fun lanAddressRank(addr: String): Int {
	if (addr.startsWith("169.254.")) return 100
	if (addr.startsWith("192.168.56.")) return 90
	if (addr.startsWith("192.168.")) return 10
	if (addr.startsWith("10.")) return 20
	val match = Regex("^172\\.(\\d+)\\.").find(addr)
	if (match != null && match.groupValues[1].toInt() in 16..31) return 30
	return 50
}

/**
 * @param addrs IPv4 列表
 * @return 按 LAN 可达性优先排序
 */
private fun prioritizeLanAddresses(addrs: List<String>): List<String> =
	addrs.sortedBy { lanAddressRank(it) }

/**
 * @param family 网卡 family
 * @return 是否 IPv4
 */
private fun isIpv4Family(family: Any?): Boolean = family == "IPv4" || (family as? Number)?.toInt() == 4

/**
 * 本机可用于 LAN 组播 / advert 的非 internal IPv4 地址。
 * @return 去重、排序后的地址列表
 */
fun listMulticastIpv4Addresses(): List<String> {
	val seen = HashSet<String>()
	val addrs = ArrayList<String>()
	for (iface in lanInterfaceProvider.listAddresses()) {
		if (iface.internal || !isIpv4Family(iface.family)) continue
		val addr = iface.address
		if (addr.isEmpty() || seen.contains(addr)) continue
		seen.add(addr)
		addrs.add(addr)
	}
	return prioritizeLanAddresses(addrs).take(MAX_LAN_HOSTS)
}
