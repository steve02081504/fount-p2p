import { createServer } from 'node:http'
import { test } from 'node:test'

import { WebSocketServer } from 'ws'

import { NOSTR_ADVERT_KIND } from '../../discovery/nostr.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

/**
 * @param {(eventId: string) => boolean} accept 是否接受 EVENT
 * @returns {Promise<{ port: number, stop: () => Promise<void> }>} fake relay
 */
async function startFakeRelay(accept) {
	const server = createServer()
	const wss = new WebSocketServer({ server })
	wss.on('connection', ws => {
		ws.on('message', raw => {
			let parsed
			try { parsed = JSON.parse(String(raw)) } catch { return }
			if (parsed?.[0] !== 'EVENT') return
			const event = parsed[1]
			const ok = accept(String(event?.id || ''))
			ws.send(JSON.stringify(['OK', event.id, ok, ok ? '' : 'blocked: test']))
		})
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	const port = typeof address === 'object' && address ? address.port : 0
	return {
		port,
		async stop() {
			await new Promise(resolve => wss.close(() => resolve()))
			await new Promise(resolve => server.close(() => resolve()))
		},
	}
}

test('NOSTR advert kind uses addressable range', () => {
	assertEquals(NOSTR_ADVERT_KIND >= 30000 && NOSTR_ADVERT_KIND < 40000, true)
})

test('publishEvent accepts relay OK true', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
	const local = identity(71)
	const relay = await startFakeRelay(() => true)
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		await provider.sendNodeSignal(local.nodeHash, new Uint8Array([1, 2, 3]))
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('publishEvent rejects when relay OK false', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
	const local = identity(72)
	const relay = await startFakeRelay(() => false)
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		let threw = false
		try {
			await provider.sendNodeSignal(local.nodeHash, new Uint8Array([1, 2, 3]))
		}
		catch {
			threw = true
		}
		assertEquals(threw, true)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})
