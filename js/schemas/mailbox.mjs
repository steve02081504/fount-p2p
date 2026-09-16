import { isHex64 } from '../core/hexIds.mjs'

/**
 * @typedef {{ ok: true, value: string }} MailboxWireOk
 * @typedef {{ ok: false, code: string, field: string }} MailboxWireErr
 * @typedef {MailboxWireOk | MailboxWireErr} MailboxWireResult
 */

/**
 * @typedef {{ ok: true, value: object }} MailboxRecordShapeOk
 * @typedef {MailboxWireErr} MailboxRecordShapeErr
 * @typedef {MailboxRecordShapeOk | MailboxRecordShapeErr} MailboxRecordShapeResult
 */

/**
 * @param {unknown} value 收件人 pubKeyHash
 * @returns {MailboxWireResult} 规范化 hex64 或结构化错误
 */
export function assertMailboxPubKeyHash(value) {
	const normalized = isHex64(value)
	if (!normalized)
		return { ok: false, code: 'invalid_hex64', field: 'toPubKeyHash' }
	return { ok: true, value: normalized }
}

/**
 * @param {unknown} record mailbox 记录
 * @returns {MailboxRecordShapeResult} 已校验的 record 或结构化错误
 */
export function assertMailboxRecordShape(record) {
	if (!record || typeof record !== 'object')
		return { ok: false, code: 'required', field: 'record' }
	const pubKey = assertMailboxPubKeyHash(record.toPubKeyHash)
	if (!pubKey.ok)
		return { ok: false, code: pubKey.code, field: 'record.toPubKeyHash' }
	return { ok: true, value: record }
}
