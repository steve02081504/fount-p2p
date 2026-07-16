/** @typedef {import('../wire/part_invoke.mjs').PartInvokeResponse} PartInvokeResponse */

/**
 * @typedef {{
 *   replicaUsername?: string
 *   requesterNodeHash?: string | null
 *   groupId?: string
 *   peerId?: string
 * }} InboundContext
 */

/**
 * @typedef {(inboundContext: InboundContext, message: object) => Promise<PartInvokeResponse | null>} RpcInboundHandler
 */

/**
 * @typedef {(inboundContext: InboundContext, message: object) => Promise<void>} DeliveryInboundHandler
 */

/** @type {Map<string, RpcInboundHandler>} */
const rpcHandlers = new Map()

/** @type {Map<string, DeliveryInboundHandler>} */
const deliveryHandlers = new Map()

/**
 * @param {string} type 入站 RPC 类型（part_invoke 等）
 * @param {RpcInboundHandler} handler 处理器
 * @returns {void}
 */
export function registerRpcInboundHandler(type, handler) {
	rpcHandlers.set(String(type || '').trim(), handler)
}

/**
 * @param {string} type 入站投递类型（part_timeline_put 等）
 * @param {DeliveryInboundHandler} handler 处理器
 * @returns {void}
 */
export function registerDeliveryInboundHandler(type, handler) {
	deliveryHandlers.set(String(type || '').trim(), handler)
}

/**
 * @param {InboundContext} inboundContext 入站上下文
 * @param {object} message 已校验的线载荷（含 type）
 * @returns {Promise<PartInvokeResponse | null>} 处理器返回值
 */
export async function dispatchRpcInbound(inboundContext, message) {
	const type = String(message?.type || '').trim()
	if (!type) return null
	const handler = rpcHandlers.get(type)
	if (!handler) return null
	return handler(inboundContext, message)
}

/**
 * @param {InboundContext} inboundContext 入站上下文
 * @param {object} message 已校验的线载荷（含 type）
 * @returns {Promise<void>}
 */
export async function dispatchDeliveryInbound(inboundContext, message) {
	const type = String(message?.type || '').trim()
	if (!type) return
	const handler = deliveryHandlers.get(type)
	if (!handler) return
	await handler(inboundContext, message)
}
