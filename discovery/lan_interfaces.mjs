import os from 'node:os'

/** advert / 组播 beacon 携带的 LAN IPv4 上限 */
export const MAX_LAN_HOSTS = 4

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/

/**
 * untrusted ingress：清洗 advert body 中的 LAN IPv4 列表。
 * @param {unknown} input 原始 lanHosts
 * @returns {string[]} 去重后的 IPv4 列表
 */
export function normalizeLanHosts(input) {
	if (!input) return []
	const arr = Array.isArray(input) ? input : [input]
	const seen = new Set()
	/** @type {string[]} */
	const out = []
	for (const item of arr) {
		const host = String(item || '').trim()
		if (!host || !IPV4_RE.test(host) || seen.has(host)) continue
		seen.add(host)
		out.push(host)
		if (out.length >= MAX_LAN_HOSTS) break
	}
	return out
}

/**
 * @param {string} addr IPv4
 * @returns {number} 排序权重（越小越优先）
 */
function lanAddressRank(addr) {
	if (addr.startsWith('169.254.')) return 100
	if (addr.startsWith('192.168.56.')) return 90
	if (addr.startsWith('192.168.')) return 10
	if (addr.startsWith('10.')) return 20
	const match = /^172\.(\d+)\./u.exec(addr)
	if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return 30
	return 50
}

/**
 * @param {string[]} addrs IPv4 列表
 * @returns {string[]} 按 LAN 可达性优先排序
 */
function prioritizeLanAddresses(addrs) {
	return [...addrs].sort((left, right) => lanAddressRank(left) - lanAddressRank(right))
}

/**
 * @param {string | number} family os.networkInterfaces family
 * @returns {boolean} 是否 IPv4
 */
function isIpv4Family(family) {
	return family === 'IPv4' || family === 4
}

/**
 * 本机可用于 LAN 组播 / advert 的非 internal IPv4 地址。
 * @returns {string[]} 去重、排序后的地址列表
 */
export function listMulticastIpv4Addresses() {
	const seen = new Set()
	/** @type {string[]} */
	const addrs = []
	for (const ifaces of Object.values(os.networkInterfaces())) {
		if (!ifaces) continue
		for (const iface of ifaces) {
			if (iface.internal || !isIpv4Family(iface.family)) continue
			const addr = String(iface.address || '').trim()
			if (!addr || seen.has(addr)) continue
			seen.add(addr)
			addrs.push(addr)
		}
	}
	return prioritizeLanAddresses(addrs).slice(0, MAX_LAN_HOSTS)
}
