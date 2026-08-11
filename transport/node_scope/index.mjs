/**
 * Node scope：subscribe + refcount feature 挂载枢纽。
 */
export {
	countNodeScopeActionHandlers,
	dispatchNodeScopeAction,
	ensureNodeScope,
	getNodeScopeContext,
	getNodeScopeWire,
	hasNodeScopeAction,
} from './wire.mjs'

/**
 * Node scope feature 挂载：mailbox、part、part_query、chunk 等 refcount attach。
 */
export {
	attachNodeScopeChunks,
	attachNodeScopeDefaultFeatures,
	attachNodeScopeFeature,
	attachNodeScopeMailbox,
	attachNodeScopePart,
	attachNodeScopePartQuery,
	stopNodeScopeRuntime,
} from './features.mjs'
