import { test } from 'node:test'

import { normalizeLanHosts, listMulticastIpv4Addresses } from '../../discovery/lan_interfaces.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('normalizeLanHosts dedupes and caps IPv4 literals', () => {
	assertEquals(
		normalizeLanHosts(['10.0.0.1', '10.0.0.1', 'bad', '', '192.168.1.2', '1.2.3', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6']),
		['10.0.0.1', '192.168.1.2', '10.0.0.3', '10.0.0.4'],
	)
})

test('listMulticastIpv4Addresses returns non-internal IPv4 addresses', () => {
	const addrs = listMulticastIpv4Addresses()
	for (const addr of addrs)
		assertEquals(/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(addr), true)
})

test('normalizeLanHosts accepts single string input', () => {
	assertEquals(normalizeLanHosts('10.0.0.9'), ['10.0.0.9'])
	assertEquals(normalizeLanHosts(null), [])
})
