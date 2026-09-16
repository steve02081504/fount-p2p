import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parsePartpath } from '../../core/partpath.mjs'
import { isPartInvokeResponse } from '../../wire/part/invoke.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'


test('parsePartpath accepts exact shells/foo paths', () => {
	assertEquals(parsePartpath('shells/social'), 'shells/social')
	assertEquals(parsePartpath('/shells/social/'), null)
	assertEquals(parsePartpath(''), null)
	assertEquals(parsePartpath('shells:social'), null)
	assertEquals(parsePartpath(null), null)
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
	const url = new URL('../../wire/part/ingress.mjs', import.meta.url)
	const text = await readFile(fileURLToPath(url), 'utf8')
	assert.ok(!text.includes('public/parts/shells/social'))
	assert.ok(!text.includes('public/parts/shells/chat'))
	assert.ok(text.includes('./invoke.mjs'))
	assert.ok(text.includes('handleIncomingPartInvokeRequest'))
	assert.ok(text.includes('handleIncomingPartInvokeFireAndForget'))
})
