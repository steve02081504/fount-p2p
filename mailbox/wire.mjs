import { subscribeWire } from '../wire/subscribe.mjs'

import {
	ingestMailboxGive,
	ingestMailboxPut,
	respondMailboxWant,
} from './deliver_or_store.mjs'
import { parseMailboxGive, parseMailboxPut, parseMailboxWant } from './parse.mjs'

/** @typedef {import('../wire/adapter.mjs').WireContext} MailboxWireContext */
/** @typedef {import('../wire/adapter.mjs').WireAdapter} WireAdapter */

/**
 * @param {MailboxWireContext} wireContext 入站上下文
 * @param {WireAdapter} wire action 表
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachMailboxWire(wireContext, wire) {
	return subscribeWire(wire, {
		mailbox_put(payload, peerId) {
			const put = parseMailboxPut(payload)
			if (!put.ok) return
			void ingestMailboxPut(wireContext, put.value, peerId).catch(error => console.error('mailbox: put ingest failed', error))
		},
		mailbox_want(payload, peerId) {
			const want = parseMailboxWant(payload)
			if (!want.ok) return
			void respondMailboxWant(want.value, (giveWire, targetPeerId) => {
				try {
					wire.send('mailbox_give', giveWire, targetPeerId)
				}
				catch { /* disconnected */ }
			}, peerId).catch(error => console.error('mailbox: want failed', error))
		},
		mailbox_give(payload) {
			const give = parseMailboxGive(payload)
			if (!give.ok) return
			void ingestMailboxGive(wireContext, give.value).catch(error => console.error('mailbox: give ingest failed', error))
		},
	})
}
