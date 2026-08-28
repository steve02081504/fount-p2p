import { buildSignedAdvert, verifySignedAdvert } from '../link/handshake.mjs'

import {
	decryptSignalPacket,
	encryptSignalPacket,
	groupRendezvousKey,
	networkRendezvousKey,
	nodeRendezvousKey,
} from './internal/signal_crypto.mjs'
import { listMulticastIpv4Addresses } from './lan_interfaces.mjs'

/** @typedef {'node' | 'network' | { roomSecret: string }} AdvertScope */

/**
 * 按 scope 派生 rendezvous 键。
 * @param {AdvertScope} scope advert 域
 * @param {string} selfNodeHash 本机 nodeHash
 * @returns {string} rendezvous 键（discovery 内部）
 */
export function rendezvousKeyForScope(scope, selfNodeHash) {
	if (scope === 'network') return networkRendezvousKey()
	if (scope === 'node') return nodeRendezvousKey(selfNodeHash)
	if (scope?.roomSecret) return groupRendezvousKey(scope.roomSecret)
	throw new Error('p2p: invalid advert scope')
}

/**
 * 为本机身份构建已签名 advert body。
 * @param {AdvertScope} scope advert 域
 * @param {{ nodeHash: string, nodePubKey: string, secretKey: Uint8Array }} localIdentity 本地身份
 * @param {number | null | undefined} [tcpPort] LAN TCP 端口
 * @param {{ pool?: Array<{ url: string, rtt?: number }>, listen?: string[] }} [relayData] 已规范化并经 sanitize 裁剪的 relay 字段
 * @returns {Promise<object>} 签名 advert body
 */
export async function buildSignedAdvertForScope(scope, localIdentity, tcpPort, relayData) {
	const key = rendezvousKeyForScope(scope, localIdentity.nodeHash)
	const lanHosts = scope === 'network' && tcpPort != null
		? listMulticastIpv4Addresses()
		: []
	return await buildSignedAdvert(key, Date.now(), {
		...localIdentity,
		...tcpPort != null ? { tcpPort } : {},
		...lanHosts.length ? { lanHosts } : {},
		...relayData?.pool ? { nostrRelayPool: relayData.pool } : {},
		...relayData?.listen ? { listenNostrRelays: relayData.listen } : {},
	})
}

/**
 * AES-GCM 封装已签名 advert 包。
 * @param {string} rendezvousKey rendezvous 键
 * @param {object} advertBody 已签名 advert
 * @returns {Uint8Array} 加密 advert 字节
 */
export function encryptAdvertPacket(rendezvousKey, advertBody) {
	return encryptSignalPacket(rendezvousKey, { type: 'advert', body: advertBody })
}

/**
 * 按 scope 加密已签名 advert。
 * @param {AdvertScope} scope advert 域
 * @param {{ nodeHash: string }} localIdentity 本地身份（仅需 nodeHash）
 * @param {object} advertBody 已签名 advert
 * @returns {Uint8Array} 加密 advert 字节
 */
export function encryptAdvertForScope(scope, localIdentity, advertBody) {
	return encryptAdvertPacket(rendezvousKeyForScope(scope, localIdentity.nodeHash), advertBody)
}

/**
 * Untrusted ingress：解密并验签 advert；失败返回 null，不抛。不写入可见池 / peer hints。
 * @param {string} rendezvousKey rendezvous 键
 * @param {Uint8Array} bytes 加密 advert
 * @returns {Promise<{ verifiedNodeHash: string, body: object, relayPool: Array<{ url: string, rtt: number }>, listenRelays: string[] } | null>} 验签成功返回 nodeHash、advert body 与规范化 relay 字段，否则 null
 */
export async function ingestEncryptedAdvert(rendezvousKey, bytes) {
	const packet = decryptSignalPacket(rendezvousKey, bytes)
	if (packet?.type !== 'advert' || !packet.body) return null
	const verified = await verifySignedAdvert(rendezvousKey, packet.body)
	if (!verified) return null
	return {
		verifiedNodeHash: verified.nodeHash,
		body: packet.body,
		relayPool: verified.relayPool,
		listenRelays: verified.listenRelays,
	}
}

/**
 * Untrusted ingress：验签 network-scope advert；失败返回 null。不写盘 / 不写 hints。
 * @param {Uint8Array} bytes 加密 advert
 * @returns {Promise<{ verifiedNodeHash: string, body: object, relayPool: Array<{ url: string, rtt: number }>, listenRelays: string[] } | null>} 验签成功返回 nodeHash、advert body 与规范化 relay 字段，否则 null
 */
export async function ingestNetworkAdvert(bytes) {
	return ingestEncryptedAdvert(networkRendezvousKey(), bytes)
}

/**
 * Untrusted ingress：验签 node-scope advert；失败返回 null。不写盘 / 不写 hints。
 * @param {string} nodeHash 目标 nodeHash
 * @param {Uint8Array} bytes 加密 advert
 * @returns {Promise<{ verifiedNodeHash: string, body: object, relayPool: Array<{ url: string, rtt: number }>, listenRelays: string[] } | null>} 验签成功返回 nodeHash、advert body 与规范化 relay 字段，否则 null
 */
export async function ingestNodeAdvert(nodeHash, bytes) {
	return ingestEncryptedAdvert(nodeRendezvousKey(nodeHash), bytes)
}

/**
 * Untrusted ingress：验签 group-scope advert；失败返回 null。不写盘 / 不写 hints。
 * @param {string} roomSecret 房间密钥
 * @param {Uint8Array} bytes 加密 advert
 * @returns {Promise<{ verifiedNodeHash: string, body: object, relayPool: Array<{ url: string, rtt: number }>, listenRelays: string[] } | null>} 验签成功返回 nodeHash、advert body 与规范化 relay 字段，否则 null
 */
export async function ingestGroupAdvert(roomSecret, bytes) {
	return ingestEncryptedAdvert(groupRendezvousKey(roomSecret), bytes)
}
