import { strict as assert } from 'node:assert'
import { test } from 'node:test'

const PACKAGE_NAME = '@steve02081504/fount-p2p'

/**
 * 按 package.json export 子路径动态导入模块（package self-reference）。
 * @param {string} subpath package.json export 子路径（带 `./` 前缀，或 `.`）
 * @returns {Promise<Record<string, unknown>>} 动态导入的模块命名空间
 */
async function importExport(subpath) {
	return import(subpath === '.' ? PACKAGE_NAME : `${PACKAGE_NAME}/${subpath.slice(2)}`)
}

test('package exports resolve to loadable modules', async () => {
	const samples = [
		'.',
		'./infra',
		'./link',
		'./crypto',
		'./crypto/channel',
		'./discovery',
		'./dag',
		'./permissions',
		'./core/hexIds',
		'./wire/part/ingress',
		'./wire/part/query',
		'./wire/part/invoke',
		'./wire/part/fanout',
		'./wire/part/pending',
		'./wire/part/group',
		'./files/chunk/responder',
		'./files/chunk/pending',
		'./core/object',
		'./core/partpath',
		'./files/chunk/store',
		'./files/manifest/normalize',
		'./files/fed/responder',
		'./federation/part_query/runtime',
		'./transport/scoped_link',
		'./transport/link_registry',
		'./transport/peer_health',
		'./transport/node_scope/wire',
		'./transport/node_scope/features',
		'./registries/event_type',
		'./registries/room_provider',
		'./schemas/mailbox',
		'./schemas/part_query',
		'./timeline/append_core',
		'./node/reputation_store',
		'./reputation/engine',
		'./trust_graph/resolve',
		'./mailbox/importance',
		'./governance/branch',
	]
	for (const subpath of samples)
		assert.equal(typeof await importExport(subpath), 'object', subpath)
})

test('transport/node_scope/wire exports registerNodeScopeWireHook', async () => {
	const mod = await importExport('./transport/node_scope/wire')
	assert.equal(typeof mod.registerNodeScopeWireHook, 'function')
	assert.equal(typeof mod.ensureNodeScope, 'function')
})
