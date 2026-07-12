/**
 * Federation P2P 门面：通用引导与房间/发现入口。
 * 重型子系统请直接从子路径导入（如 `./dag/index.mjs`）。
 */
import { registerDiscoveryProvider } from './discovery/index.mjs'
import { ensureNodeDefaults, getNodeHash } from './node/identity.mjs'
import { getNodeDir, initNode, isNodeInitialized } from './node/instance.mjs'
import { createScopedLinkRoom } from './rooms/scoped_link.mjs'
import { createGroupLinkSet } from './transport/group_link_set.mjs'
import { getLinkRegistry } from './transport/link_registry.mjs'
import { ensureUserRoom } from './transport/user_room.mjs'

/**
 *
 */
export {
	createGroupLinkSet,
	createScopedLinkRoom,
	ensureNodeDefaults,
	ensureUserRoom,
	getLinkRegistry,
	getNodeDir,
	getNodeHash,
	initNode,
	isNodeInitialized,
	registerDiscoveryProvider,
}

/**
 * 初始化并启动 P2P 节点运行时（身份、链路网、link registry）。
 * @param {{ nodeDir: string, entityStore?: import('./node/entity_store.mjs').EntityStore, logger?: object, signaling?: import('./node/signaling_config.mjs').SignalingRuntimeConfig }} options 节点配置
 * @returns {Promise<void>}
 */
export async function startNode(options) {
	if (!isNodeInitialized())
		initNode(options)
	ensureNodeDefaults()
	await getLinkRegistry().ensureRuntime()
}
