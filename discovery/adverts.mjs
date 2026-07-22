import { normalizeHex64 } from '../core/hexIds.mjs'
import { buildSignedAdvert, verifySignedAdvert } from '../link/handshake.mjs'

import { listMulticastIpv4Addresses } from './lan_interfaces.mjs'

import {
	decryptSignalPacket,
	encryptSignalPacket,
	groupRendezvousKey,
	networkRendezvousKey,
	nodeRendezvousKey,
} from './internal/signal_crypto.mjs'

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
 * @returns {Promise<object>} 签名 advert body
 */
export async function buildSignedAdvertForScope(scope, localIdentity, tcpPort) {
	const key = rendezvousKeyForScope(scope, localIdentity.nodeHash)
	const lanHosts = scope === 'network' && tcpPort != null
		? listMulticastIpv4Addresses()
		: []
	return await buildSignedAdvert(key, Date.now(), {
		...localIdentity,
		...tcpPort != null ? { tcpPort } : {},
		...lanHosts.length ? { lanHosts } : {},
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
 * @param {object} [meta] 元数据
 * @returns {Promise<{ verifiedNodeHash: string, body: object } | null>} 验签成功返回 nodeHash 与 advert body，否则 null
 */
export async function ingestEncryptedAdvert(rendezvousKey, bytes, meta) {
	void meta
	const packet = decryptSignalPacket(rendezvousKey, bytes)
	if (packet?.type !== 'advert' || !packet.body) return null
	const verifiedNodeHash = await verifySignedAdvert(rendezvousKey, packet.body)
	if (!verifiedNodeHash) return null
	return { verifiedNodeHash, body: packet.body }
}

/**
 * Untrusted ingress：验签 network-scope advert；失败返回 null。不写盘 / 不写 hints。
 * @param {Uint8Array} bytes 加密 advert
 * @param {object} [meta] 元数据
 * @returns {Promise<{ verifiedNodeHash: string, body: object } | null>} 验签成功返回 nodeHash 与 advert body，否则 null
 */
export async function ingestNetworkAdvert(bytes, meta) {
	return ingestEncryptedAdvert(networkRendezvousKey(), bytes, meta)
}

/**
 * Untrusted ingress：验签 node-scope advert；失败返回 null。不写盘 / 不写 hints。
 * @param {string} nodeHash 目标 nodeHash
 * @param {Uint8Array} bytes 加密 advert
 * @param {object} [meta] 元数据
 * @returns {Promise<{ verifiedNodeHash: string, body: object } | null>} 验签成功返回 nodeHash 与 advert body，否则 null
 */
export async function ingestNodeAdvert(nodeHash, bytes, meta) {
	return ingestEncryptedAdvert(nodeRendezvousKey(normalizeHex64(nodeHash)), bytes, meta)
}

/**
 * Untrusted ingress：验签 group-scope advert；失败返回 null。不写盘 / 不写 hints。
 * @param {string} roomSecret 房间密钥
 * @param {Uint8Array} bytes 加密 advert
 * @param {object} [meta] 元数据
 * @returns {Promise<{ verifiedNodeHash: string, body: object } | null>} 验签成功返回 nodeHash 与 advert body，否则 null
 */
export async function ingestGroupAdvert(roomSecret, bytes, meta) {
	return ingestEncryptedAdvert(groupRendezvousKey(roomSecret), bytes, meta)
}
