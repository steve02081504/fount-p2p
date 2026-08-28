import path from 'node:path'

import { readJsonFileSync, writeJsonFileSync } from '../utils/json_io.mjs'

import { getNodeDir } from './instance.mjs'

/**
 * @param {string} name 不含扩展名的配置文件名
 * @returns {string} 绝对路径
 */
export function nodeJsonPath(name) {
	return path.join(getNodeDir(), `${name}.json`)
}

/**
 * @param {string} name 配置文件名
 * @returns {object | null} 解析后的 JSON 或 null
 */
export function readNodeJsonSync(name) {
	return readJsonFileSync(nodeJsonPath(name))
}

/**
 * @param {string} name 配置文件名
 * @param {unknown} data 数据
 * @returns {void}
 */
export function writeNodeJsonSync(name, data) {
	writeJsonFileSync(nodeJsonPath(name), data)
}

/**
 * Nostr relay 池 / peer 路由持久化文件路径（`nodeDir/nostr/relays.json`）。
 * @returns {string} 绝对路径
 */
export function nostrRelayJsonPath() {
	return path.join(getNodeDir(), 'nostr', 'relays.json')
}

/**
 * @returns {object | null} 解析后的 Nostr relay JSON 或 null
 */
export function readNostrRelaysJsonSync() {
	return readJsonFileSync(nostrRelayJsonPath())
}

/**
 * @param {unknown} data 数据
 * @returns {void}
 */
export function writeNostrRelaysJsonSync(data) {
	writeJsonFileSync(nostrRelayJsonPath(), data)
}
