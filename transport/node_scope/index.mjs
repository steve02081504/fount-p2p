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
 *
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
