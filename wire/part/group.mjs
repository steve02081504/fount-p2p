import { isPlainObject } from '../../core/object.mjs'

import { attachPartWire } from './ingress.mjs'

/** @typedef {import('../../wire/adapter.mjs').WireAdapter} WireAdapter */
/** @typedef {import('../../wire/adapter.mjs').WireContext} WireContext */

/**
 * @param {unknown} data part 载荷
 * @param {string} groupId 群 ID
 * @returns {object | null} 校验通过后的载荷
 */
function parseGroupContext(data, groupId) {
	if (!isPlainObject(data)) return null
	if (data.groupId !== groupId) return null
	return data
}

/**
 * @param {WireAdapter} wire 底层适配器
 * @param {string} groupId 群 ID
 * @returns {WireAdapter['on']} 注入 groupId 的 on 包装
 */
function wrapWireOn(wire, groupId) {
	return (name, handler) => wire.on(name, (data, peerId) => {
		const payload = parseGroupContext(data, groupId)
		if (!payload) return
		handler(payload, peerId)
	})
}

/**
 * 群联邦房间挂载 part_wire（要求线载荷带 `groupId`）。
 * @param {WireContext} wireContext 入站上下文
 * @param {string} groupId 群 ID
 * @param {WireAdapter} wire action 表
 * @param {{ allowPartInvoke?: (payload: object) => boolean }} [options] 入站过滤
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachGroupPartWire(wireContext, groupId, wire, options = {}) {
	return attachPartWire(wireContext, {
		send: wire.send.bind(wire),
		on: wrapWireOn(wire, groupId),
	}, options)
}
