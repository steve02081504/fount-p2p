import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { logicalEntityHash } from '../../core/logical_entity.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const register = new URL('../helpers/unenv_crypto_register.mjs', import.meta.url).href
const probe = fileURLToPath(new URL('../helpers/logical_entity_unenv_probe.mjs', import.meta.url))

/** `logicalEntityHash('fount:chat:group:test')` 稳定向量（sentinel + SHA-256(subject)）。 */
const FOUNT_CHAT_GROUP_TEST_ENTITY_HASH =
	'0000000000000000000000000000000000000000000000000000000000000000' +
	'b7829aed7b73408ad6e3c412bef8cb3afcf344bda185d50c0a7d573b8f0329b1'

test('logicalEntityHash works when node:crypto createHash throws like unenv', () => {
	const result = spawnSync(process.execPath, ['--import', register, probe], {
		cwd: root,
		encoding: 'utf8',
	})
	assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
	const hash = result.stdout.trim()
	assertEquals(hash, FOUNT_CHAT_GROUP_TEST_ENTITY_HASH)
	assertEquals(hash, logicalEntityHash('fount:chat:group:test'))
})
