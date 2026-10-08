import { test } from 'node:test'

import { createNostrDiscoveryProvider } from '../../discovery/nostr/index.mjs'
import { clearRelayPoolForTests, registerProviderTrustedRelayUrls, setPeerRoute } from '../../discovery/nostr/relays.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'
import { identity } from '../helpers/identity.mjs'

test('directed signals reach disjoint advertised listen relays in both directions with explicit local relays', async () => {
	const relays = await Promise.all([startFakeRelay(() => true, { broadcast: true }), startFakeRelay(() => true, { broadcast: true })])
	const urls = relays.map(relay => `ws://127.0.0.1:${relay.port}`)
	const nodes = [identity(101).nodeHash, identity(102).nodeHash]
	const releaseTrust = registerProviderTrustedRelayUrls(urls)
	const providers = [createNostrDiscoveryProvider({ relayUrls: [urls[0]] }),
		createNostrDiscoveryProvider({ getRelayUrls: () => [urls[1]] })]
	const received = [[], []]
	try {
		for (let index = 0; index < 2; index++) {
			setPeerRoute(nodes[index], { listenRelays: [urls[index]] })
			await providers[index].listenNodeSignals(nodes[index], bytes => received[index].push([...bytes]))
			await relays[index].waitReqs(1)
		}
		await providers[0].sendNodeSignal(nodes[1], new Uint8Array([1]))
		await providers[1].sendNodeSignal(nodes[0], new Uint8Array([2]))
		const deadline = Date.now() + 2_000
		while (received.some(rows => !rows.length) && Date.now() < deadline)
			await new Promise(resolve => setTimeout(resolve, 10))
		assertEquals(received, [[[2]], [[1]]])
	}
	finally {
		for (const provider of providers) provider.dispose()
		releaseTrust()
		for (const relay of relays) await relay.stop()
	}
})

test('a routed signal with no reachable relay rejects instead of reporting success', async () => {
	clearRelayPoolForTests()
	const provider = createNostrDiscoveryProvider()
	try {
		await assert.rejects(provider.sendNodeSignal(identity(103).nodeHash, new Uint8Array([3])), /no relay accepted directed signal/)
	}
	finally { provider.dispose() }
})
