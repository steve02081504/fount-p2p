import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isPartInvokeResponse, normalizePartpath } from '../../wire/part_invoke.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'


test('normalizePartpath accepts shells/foo paths', () => {
	assertEquals(normalizePartpath('shells/social'), 'shells/social')
	assertEquals(normalizePartpath('/shells/social/'), 'shells/social')
	assertEquals(normalizePartpath(''), null)
	assertEquals(normalizePartpath('shells:social'), null)
})

test('isPartInvokeResponse rejects empty and ambiguous shapes', () => {
	assertEquals(isPartInvokeResponse({}), false)
	assertEquals(isPartInvokeResponse({ result: 1, error: { message: 'x', code: 'X' } }), false)
	assertEquals(isPartInvokeResponse({ error: { message: 'fail' } }), false)
	assert.ok(isPartInvokeResponse({ error: { message: 'fail', code: 'FAIL' } }))
	assert.ok(isPartInvokeResponse({ result: { ok: true } }))
	assertEquals(isPartInvokeResponse(null), false)
})

test('part wire does not import shell parts', async () => {
	const url = new URL('../../wire/part_ingress.mjs', import.meta.url)
	const text = await readFile(fileURLToPath(url), 'utf8')
	assert.ok(!text.includes('public/parts/shells/social'))
	assert.ok(!text.includes('public/parts/shells/chat'))
	assert.ok(text.includes('part_invoke.mjs'))
	assert.ok(text.includes('handleIncomingPartInvokeRequest'))
	assert.ok(text.includes('handleIncomingPartInvokeFireAndForget'))
})
