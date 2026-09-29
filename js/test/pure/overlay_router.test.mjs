import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { keyPairFromSeed, pubKeyHash, sign } from '../../crypto/crypto.mjs'
import { createOverlayRouter } from '../../overlay/index.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'

/**
 * 从固定 seed 生成测试身份。
 * @param {number} fill seed 填充字节值
 * @returns {{ nodeHash: string, nodePubKey: string, secretKey: Uint8Array }} 节点身份
 */
function identity(fill) {
	const { publicKey, secretKey } = keyPairFromSeed(Buffer.alloc(32, fill))
	return {
		nodeHash: pubKeyHash(publicKey),
		nodePubKey: Buffer.from(publicKey).toString('hex'),
		secretKey,
	}
}

/**
 * 创建 fake overlay 网络（内存 registry + 邻接表）。
 * @param {Map<string, string[]>} edges 节点 → 邻居 nodeHash 列表
 * @returns {{ makeRegistry: (localIdentity: { nodeHash: string, nodePubKey: string, secretKey: Uint8Array }) => object }} 网络工厂
 */
function createFakeNetwork(edges) {
	const registries = new Map()
	const listenersByNode = new Map()

	/**
	 * 查询节点的邻居列表。
	 * @param {string} nodeHash 节点 hash
	 * @returns {Array<{ nodeHash: string }>} 邻居描述
	 */
	function neighborsOf(nodeHash) {
		return (edges.get(nodeHash) || []).map(target => ({ nodeHash: target }))
	}

	/**
	 * 为本地身份创建 fake link registry。
	 * @param {{ nodeHash: string, nodePubKey: string, secretKey: Uint8Array }} localIdentity 本地身份
	 * @returns {object} fake registry 对象
	 */
	function makeRegistry(localIdentity) {
		const scopeListeners = new Map()
		const registry = {
			localIdentity,
			/**
			 * 列出当前节点的链路邻居。
			 * @returns {Array<{ nodeHash: string }>} 邻居列表
			 */
			listLinks: () => neighborsOf(localIdentity.nodeHash),
			/**
			 * 按 scope 前缀订阅 envelope。
			 * @param {string} prefix scope 前缀
			 * @param {Function} handler envelope 处理器
			 * @returns {() => void} 取消订阅函数
			 */
			subscribeScope(prefix, handler) {
				if (!scopeListeners.has(prefix)) scopeListeners.set(prefix, new Set())
				scopeListeners.get(prefix).add(handler)
				return () => scopeListeners.get(prefix)?.delete(handler)
			},
			/**
			 * 向目标节点投递 envelope。
			 * @param {string} targetNodeHash 目标节点 hash
			 * @param {object} envelope 待投递 envelope
			 * @returns {Promise<boolean>} 是否投递成功
			 */
			async sendToNodeLink(targetNodeHash, envelope) {
				const target = registries.get(targetNodeHash)
				if (!target) return false
				for (const [prefix, handlers] of listenersByNode.get(targetNodeHash).entries())
					if (String(envelope.scope || '').startsWith(prefix))
						for (const handler of handlers)
							handler(localIdentity.nodeHash, envelope, null)
				return true
			},
		}
		registries.set(localIdentity.nodeHash, registry)
		listenersByNode.set(localIdentity.nodeHash, scopeListeners)
		return registry
	}

	return { makeRegistry }
}

test('overlay router drops relay without a valid origin signature', async () => {
	const ids = [31, 32, 33].map(identity)
	const edges = new Map([
		[ids[2].nodeHash, [ids[1].nodeHash]],
		[ids[1].nodeHash, [ids[2].nodeHash]],
	])
	const network = createFakeNetwork(edges)
	const attackerRegistry = network.makeRegistry(ids[2])
	const targetRegistry = network.makeRegistry(ids[1])
	const attacker = createOverlayRouter(attackerRegistry)
	const target = createOverlayRouter(targetRegistry)
	const received = []
	const stop = target.onRelay((body, meta) => received.push({ body, meta }))
	try {
		// 冒充第三方 origin，无签名：必须被丢弃。
		await attackerRegistry.sendToNodeLink(ids[1].nodeHash, {
			scope: 'overlay',
			action: 'relay',
			payload: { action: 'relay', path: [ids[0].nodeHash, ids[1].nodeHash], idx: 1, body: { forged: true } },
		})
		await new Promise(resolve => setTimeout(resolve, 20))
		assertEquals(received.length, 0)
		// 用自己的身份走合法 relay API：应送达并以自己为来源。
		await attacker.relay([ids[2].nodeHash, ids[1].nodeHash], { legit: true })
		await new Promise(resolve => setTimeout(resolve, 20))
		assertEquals(received.length, 1)
		assertEquals(received[0].meta.path[0], ids[2].nodeHash)
	}
	finally {
		stop()
		attacker.close()
		target.close()
	}
})

test('overlay router rate-limits route_req by default without infra', async () => {
	const ids = [21, 22, 23].map(identity)
	const edges = new Map([
		[ids[0].nodeHash, [ids[1].nodeHash, ids[2].nodeHash]],
		[ids[1].nodeHash, [ids[0].nodeHash]],
		[ids[2].nodeHash, [ids[0].nodeHash]],
	])
	const network = createFakeNetwork(edges)
	const localRegistry = network.makeRegistry(ids[0])
	network.makeRegistry(ids[1])
	const attackerRegistry = network.makeRegistry(ids[2])
	const local = createOverlayRouter(localRegistry)
	const origSend = localRegistry.sendToNodeLink.bind(localRegistry)
	let forwarded = 0
	/**
	 * 记录转发次数后委托原方法。
	 * @param {string} target 目标节点 hash
	 * @param {object} envelope 链路信封
	 * @returns {Promise<unknown>} 原方法结果
	 */
	localRegistry.sendToNodeLink = async (target, envelope) => {
		forwarded++
		return await origSend(target, envelope)
	}
	try {
		const target = 'f'.repeat(64)
		for (let i = 0; i < 40; i++)
			await attackerRegistry.sendToNodeLink(ids[0].nodeHash, {
				scope: 'overlay',
				action: 'route_req',
				payload: { action: 'route_req', reqId: `flood-${i}`, target, ttl: 3, path: [ids[2].nodeHash] },
			})
		await new Promise(resolve => setTimeout(resolve, 50))
		// 默认桶 burst=30：第 31 条起被丢弃，不再向其它链路转发。
		assert.ok(forwarded >= 30, `expected >=30 forwarded, got ${forwarded}`)
		assert.ok(forwarded < 40, `expected <40 forwarded, got ${forwarded}`)
	}
	finally {
		local.close()
	}
})

test('overlay router relays payload across a chain', async () => {
	const ids = [1, 2, 3, 4, 5].map(identity)
	const edges = new Map([
		[ids[0].nodeHash, [ids[1].nodeHash]],
		[ids[1].nodeHash, [ids[0].nodeHash, ids[2].nodeHash]],
		[ids[2].nodeHash, [ids[1].nodeHash, ids[3].nodeHash]],
		[ids[3].nodeHash, [ids[2].nodeHash, ids[4].nodeHash]],
		[ids[4].nodeHash, [ids[3].nodeHash]],
	])
	const network = createFakeNetwork(edges)
	const routers = ids.map(id => createOverlayRouter(network.makeRegistry(id)))
	const received = []
	const stop = routers[4].onRelay((body, meta) => received.push({ body, meta }))
	try {
		const path = ids.map(id => id.nodeHash)
		await routers[0].relay(path, { ok: true })
		await new Promise(resolve => setTimeout(resolve, 50))
		assertEquals(received.length, 1)
		assertEquals(received[0].body.ok, true)
	}
	finally {
		stop()
		for (const router of routers) router.close()
	}
})

test('overlay router ignores route response whose path does not end at the target', async () => {
	const ids = [11, 12, 13].map(identity)
	const edges = new Map([
		[ids[0].nodeHash, [ids[1].nodeHash]],
		[ids[1].nodeHash, [ids[0].nodeHash]],
	])
	const network = createFakeNetwork(edges)
	const leftRegistry = network.makeRegistry(ids[0])
	const evilRegistry = network.makeRegistry(ids[1])
	const left = createOverlayRouter(leftRegistry)
	const origSend = leftRegistry.sendToNodeLink.bind(leftRegistry)
	let capturedReqId = ''
	/**
	 * 捕获 route_req 的 reqId 后委托原方法。
	 * @param {string} target 目标节点 hash
	 * @param {object} envelope 链路信封
	 * @returns {Promise<unknown>} 原方法结果
	 */
	leftRegistry.sendToNodeLink = async (target, envelope) => {
		if (envelope?.action === 'route_req') capturedReqId = envelope.payload?.reqId || ''
		return await origSend(target, envelope)
	}
	try {
		const routePromise = left.discoverRoute(ids[2].nodeHash, { timeoutMs: 80 })
		await new Promise(resolve => setTimeout(resolve, 10))
		assertEquals(capturedReqId.length > 0, true)
		const fakePath = [ids[0].nodeHash, ids[1].nodeHash]
		const sig = await sign(
			Buffer.from(`fount-route\0${capturedReqId}\0${fakePath.join(',')}`, 'utf8'),
			ids[1].secretKey,
		)
		await evilRegistry.sendToNodeLink(ids[0].nodeHash, {
			scope: 'overlay',
			action: 'route_resp',
			payload: {
				action: 'route_resp',
				reqId: capturedReqId,
				path: fakePath,
				nodePubKey: ids[1].nodePubKey,
				sig: Buffer.from(sig).toString('hex'),
			},
		})
		// 伪造路径终点不是目标：必须被忽略，最终超时拒绝。
		await assert.rejects(async () => await routePromise)
	}
	finally {
		left.close()
	}
})

test('overlay router rejects forged route responses', async () => {
	const ids = [7, 8].map(identity)
	const edges = new Map([
		[ids[0].nodeHash, [ids[1].nodeHash]],
		[ids[1].nodeHash, [ids[0].nodeHash]],
	])
	const network = createFakeNetwork(edges)
	const left = createOverlayRouter(network.makeRegistry(ids[0]))
	const rightRegistry = network.makeRegistry(ids[1])
	try {
		const routePromise = left.discoverRoute(ids[1].nodeHash, { timeoutMs: 50 })
		await rightRegistry.sendToNodeLink(ids[0].nodeHash, {
			scope: 'overlay',
			action: 'route_resp',
			payload: {
				action: 'route_resp',
				reqId: 'bad',
				path: [ids[0].nodeHash, ids[1].nodeHash],
				nodePubKey: ids[1].nodePubKey,
				sig: '00'.repeat(64),
			},
		})
		await assert.rejects(async () => await routePromise)
	}
	finally {
		left.close()
	}
})
