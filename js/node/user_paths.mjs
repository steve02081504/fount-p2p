import path from 'node:path'

import { getNodeDir } from './instance.mjs'

/**
 * @returns {string} P2P 邮箱存储转发 JSONL 路径
 */
export function mailboxStorePath() {
	return path.join(getNodeDir(), 'mailbox', 'store.jsonl')
}
