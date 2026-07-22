import { test } from 'node:test'

import {
	clearDiscoveryProviders,
	getDiscoveryProvider,
	registerDiscoveryProvider,
	unregisterDiscoveryProvider,
} from '../../discovery/index.mjs'
import { createNostrDiscoveryProvider } from '../../discovery/nostr.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

test('nostr provider dispose stops connectToNode advert subscriptions', async () => {
	const provider = createNostrDiscoveryProvider({ relayUrls: [] })
	assert.equal(typeof provider.dispose, 'function')
	const a = identity(11).nodeHash
	const b = identity(12).nodeHash
	assertEquals(await provider.connectToNode(a), true)
	assertEquals(await provider.connectToNode(b), true)
	provider.dispose()
	assertEquals(await provider.connectToNode(a), true)
	provider.dispose()
})

test('unregisterDiscoveryProvider disposes previous nostr provider before replace', async () => {
	clearDiscoveryProviders()
	/** @type {number} */
	let disposed = 0
	const first = createNostrDiscoveryProvider({ relayUrls: [] })
	const originalDispose = first.dispose?.bind(first)
	/**
	 *
	 */
	first.dispose = () => {
		disposed++
		originalDispose?.()
	}
	registerDiscoveryProvider(first)
	await first.connectToNode(identity(13).nodeHash)
	unregisterDiscoveryProvider('nostr')
	assertEquals(disposed, 1)
	const second = createNostrDiscoveryProvider({ relayUrls: [] })
	registerDiscoveryProvider(second)
	assertEquals(getDiscoveryProvider('nostr')?.id, 'nostr')
	second.dispose?.()
	clearDiscoveryProviders()
})
