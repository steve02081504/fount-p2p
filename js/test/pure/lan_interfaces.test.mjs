import { test } from 'node:test'

import {
	MAX_LAN_HOSTS,
	normalizeLanHosts,
} from '../../discovery/lan_interfaces.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('normalizeLanHosts accepts private and link-local IPv4', () => {
	assertEquals(normalizeLanHosts(['192.168.1.5']), ['192.168.1.5'])
	assertEquals(normalizeLanHosts(['10.0.0.1']), ['10.0.0.1'])
	assertEquals(normalizeLanHosts(['172.16.0.1']), ['172.16.0.1'])
	assertEquals(normalizeLanHosts(['172.31.255.254']), ['172.31.255.254'])
	assertEquals(normalizeLanHosts(['169.254.10.20']), ['169.254.10.20'])
})

test('normalizeLanHosts rejects public, loopback, unspecified, multicast and broadcast', () => {
	for (const host of ['8.8.8.8', '1.2.3.4', '127.0.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '172.32.0.1', '172.15.0.1'])
		assertEquals(normalizeLanHosts([host]), [], `should reject ${host}`)
})

test('normalizeLanHosts rejects malformed input and out-of-range octets', () => {
	for (const host of ['not-an-ip', '999.999.999.999', '192.168.1', '192.168.1.1.1', '', null, undefined])
		assertEquals(normalizeLanHosts([host]), [], `should reject ${String(host)}`)
})

test('normalizeLanHosts dedupes and caps at MAX_LAN_HOSTS', () => {
	const many = ['10.0.0.1', '10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5']
	assertEquals(normalizeLanHosts(many).length, MAX_LAN_HOSTS)
	assertEquals(normalizeLanHosts(['10.0.0.1', '10.0.0.1']), ['10.0.0.1'])
})
