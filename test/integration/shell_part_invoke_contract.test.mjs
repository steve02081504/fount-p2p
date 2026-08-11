import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 壳层（fount social / cabinet）依赖的公开子路径与符号。
 * 误删或改名会让此测试失败，避免再 silent break 壳层。
 */
const SHELL_CONTRACT = [
	{
		subpath: './wire/part/fanout',
		exports: [
			'collectPartInvokeResponses',
			'partInvokeDataRows',
			'partInvokeErrorMessages',
			'PART_INVOKE_FANOUT_DEFAULT',
			'TIMELINE_FANOUT_LIMIT',
		],
	},
	{
		subpath: './wire/part/group',
		exports: [
			'attachGroupPartWire',
		],
	},
	{
		subpath: './wire/part/ingress',
		exports: [
			'attachPartWire',
			'handleIncomingPartInvokeRequest',
			'handleIncomingPartInvokeFireAndForget',
		],
	},
	{
		subpath: './wire/part/invoke',
		exports: [
			'isPartInvoke',
			'isPartInvokeResponse',
			'unwrapPartInvokeResult',
		],
	},
	{
		subpath: './wire/part/pending',
		exports: [
			'pendingPartInvoke',
			'handleIncomingPartInvokeResponse',
		],
	},
	{
		subpath: './files/chunk/responder',
		exports: [
			'handleFedChunkGetIngress',
			'handleFedChunkDataIngress',
			'attachTrustGraphFedChunkResponder',
		],
	},
	{
		subpath: './files/chunk/pending',
		exports: [
			'registerChunkFetchWait',
			'resolveChunkFetchWait',
			'resolvePendingChunkFetch',
		],
	},
	{
		subpath: './core/object',
		exports: [
			'isPlainObject',
		],
	},
	{
		subpath: './core/partpath',
		exports: [
			'parsePartpath',
		],
	},
]

const packageRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PACKAGE_NAME = '@steve02081504/fount-p2p'

/**
 * @param {string} subpath package export 子路径（带 `./` 前缀）
 * @returns {string} package self-reference 标识符
 */
function packageSelfReference(subpath) {
	return `${PACKAGE_NAME}/${subpath.slice(2)}`
}

test('shell part_invoke contract exports stay loadable', async () => {
	for (const entry of SHELL_CONTRACT) {
		const moduleNamespace = await import(packageSelfReference(entry.subpath))
		for (const name of entry.exports)
			assert.notEqual(moduleNamespace[name], undefined, `${entry.subpath} must export ${name}`)
	}
})

test('attachPartWire registers part_invoke_response collector', async () => {
	const text = await readFile(path.join(packageRoot, 'wire/part/ingress.mjs'), 'utf8')
	assert.match(text, /part_invoke_response/)
	assert.match(text, /handleIncomingPartInvokeResponse/)
})
