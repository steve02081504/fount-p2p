import {
	ingestMailboxGive,
	ingestMailboxPut,
	respondMailboxWant,
} from './deliver_or_store.mjs'
import { parseMailboxGive, parseMailboxPut, parseMailboxWant } from './parse.mjs'

/**
 * @typedef {{ replicaUsername?: string }} MailboxWireContext
 */

/**
 * @param {MailboxWireContext} wireContext 入站上下文
 * @param {{ on: (name: string, handler: (payload: unknown, peerId: string) => void) => (() => void) | void, send: (name: string, payload: unknown, peerId: string | null) => void }} wire Trystero 适配器
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachMailboxWire(wireContext, wire) {
	const offs = [
		wire.on('mailbox_put', (payload, peerId) => {
			const put = parseMailboxPut(payload)
			if (!put.ok) return
			void ingestMailboxPut(wireContext, put.value, peerId).catch(error => console.error('mailbox: put ingest failed', error))
		}),
		wire.on('mailbox_want', (payload, peerId) => {
			const want = parseMailboxWant(payload)
			if (!want.ok) return
			void respondMailboxWant(want.value, (giveWire, targetPeerId) => {
				try {
					wire.send('mailbox_give', giveWire, targetPeerId)
				}
				catch { /* disconnected */ }
			}, peerId).catch(error => console.error('mailbox: want failed', error))
		}),
		wire.on('mailbox_give', payload => {
			const give = parseMailboxGive(payload)
			if (!give.ok) return
			void ingestMailboxGive(wireContext, give.value).catch(error => console.error('mailbox: give ingest failed', error))
		}),
	]
	return () => {
		for (const off of offs)
			try { off?.() } catch { /* ignore */ }
	}
}
