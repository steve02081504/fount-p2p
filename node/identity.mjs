import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

import { entityHashFromRecoveryPubKeyHex, parseEntityHash } from '../core/entity_id.mjs'
import { isHex64 } from '../core/hexIds.mjs'
import { keyPairFromSeed, pubKeyHash } from '../crypto/crypto.mjs'
import { normalizeMailboxSettings } from '../mailbox/settings.mjs'

import { emitNodeChange } from './instance.mjs'
import { readNodeJsonSync, writeNodeJsonSync } from './storage.mjs'

const NODE_SEED_HEX_RE = /^[\da-f]{64}$/iu
const NODE_JSON = 'node'

/**
 * 由持久化 nodeSeed 派生 nodeHash（64 hex）。
 * @param {string} seedHex 32 字节 hex
 * @returns {string} 节点哈希
 */
export function nodeHashFromSeed(seedHex) {
	const seed = Buffer.from(String(seedHex).trim(), 'hex')
	if (seed.length !== 32) throw new Error('invalid node seed')
	const { publicKey } = keyPairFromSeed(seed)
	return pubKeyHash(publicKey)
}

/**
 * @returns {object} 节点配置磁盘对象
 */
function loadNodeFile() {
	return readNodeJsonSync(NODE_JSON) || {}
}

/**
 * @param {object} patch 部分字段
 * @returns {object} 合并后写盘
 */
function saveNodeFile(patch) {
	const data = { ...loadNodeFile(), ...patch }
	writeNodeJsonSync(NODE_JSON, data)
	emitNodeChange('node-config-changed', { patch })
	return data
}

/**
 * @returns {string} 64 位十六进制 节点种子
 */
export function ensureNodeSeed() {
	const data = loadNodeFile()
	const existing = String(data.nodeSeedHex || '').trim().toLowerCase()
	if (NODE_SEED_HEX_RE.test(existing)) return existing
	const nodeSeedHex = randomBytes(32).toString('hex')
	saveNodeFile({ nodeSeedHex })
	return nodeSeedHex
}

/**
 * @returns {string} 本节点 64 hex nodeHash
 */
export function getNodeHash() {
	return nodeHashFromSeed(ensureNodeSeed())
}

/**
 * @returns {{ relayUrls: string[], batterySaver: boolean, mailbox: ReturnType<typeof normalizeMailboxSettings> }} 传输与 mailbox 配置
 */
export function getNodeTransportSettings() {
	const data = loadNodeFile()
	const relayUrls = (data.relayUrls || [])
		.map(url => url.trim())
		.filter(url => url.startsWith('wss://'))
	const batterySaver = !!data.batterySaver
	const mailbox = normalizeMailboxSettings(data.mailbox || {})
	return { relayUrls, batterySaver, mailbox }
}

/**
 * @param {object} patch 部分字段
 * @returns {ReturnType<typeof getNodeTransportSettings>} 保存后的传输配置
 */
export function saveNodeTransportSettings(patch) {
	const data = loadNodeFile()
	if (patch.batterySaver != null) data.batterySaver = !!patch.batterySaver
	if (patch.relayUrls)
		data.relayUrls = patch.relayUrls.map(url => url.trim()).filter(url => url.startsWith('wss://'))
	if (patch.mailbox)
		data.mailbox = normalizeMailboxSettings({ ...data.mailbox, ...patch.mailbox })
	saveNodeFile(data)
	return getNodeTransportSettings()
}

/**
 * 确保 node.json 存在且含 nodeSeed、mailbox 默认值。
 * @returns {ReturnType<typeof getNodeTransportSettings> & { nodeHash: string }} 默认配置与 nodeHash
 */
export function ensureNodeDefaults() {
	ensureNodeSeed()
	const data = loadNodeFile()
	if (!data.mailbox) saveNodeFile({ mailbox: normalizeMailboxSettings({}) })
	return { ...getNodeTransportSettings(), nodeHash: getNodeHash() }
}

/**
 * @param {string} nodeHash 64 位十六进制
 * @param {string} recoveryPubKeyHex 64 位十六进制 recovery 公钥（稳定身份锚）
 * @returns {string | null} entityHash（非法 hex 时 null）
 */
export function entityHashFromKeys(nodeHash, recoveryPubKeyHex) {
	const pub = String(recoveryPubKeyHex || '').trim().toLowerCase().replace(/^0x/iu, '')
	if (!isHex64(nodeHash) || !isHex64(pub)) return null
	return entityHashFromRecoveryPubKeyHex(nodeHash, pub)
}

/**
 * @param {string} recoveryPubKeyHex 64 位十六进制 recovery 公钥
 * @returns {string | null} 本节点 entityHash
 */
export function resolveLocalEntityHashFromRecoveryPubKeyHex(recoveryPubKeyHex) {
	return entityHashFromKeys(getNodeHash(), recoveryPubKeyHex)
}

/**
 * @param {string} entityHash 目标 entityHash
 * @returns {boolean} 是否为本节点可写实体
 */
export function isWritableLocalEntity(entityHash) {
	const parsed = parseEntityHash(entityHash)
	if (!parsed) return false
	return parsed.nodeHash === getNodeHash()
}
