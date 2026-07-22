/**
 * Federation P2P 门面：fount 网络引导与房间/发现入口。
 */
import { registerDiscoveryProvider } from './discovery/index.mjs'
import {
	isInfraRunning,
	setInfraPriority,
	startInfra,
	stopInfra,
} from './infra/service.mjs'
import { registerLinkProvider } from './link/providers/index.mjs'
import { ensureNodeDefaults, getNodeHash } from './node/identity.mjs'
import {
	getNodeDir,
	initNode,
	isNodeInitialized,
	setNodeLogger,
	setSignalingRuntimeConfig,
} from './node/instance.mjs'
import { setConnectivityDebug } from './node/log.mjs'
import {
	attachReputationSyncWire,
	getReputationExportAllowlist,
	getReputationLocks,
	getReputationTable,
	getTrustSyncDonors,
	lockReputationMax,
	pullReputationFromNode,
	setReputationExportAllowlist,
	setReputationTable,
	setTrustSyncDonors,
	unlockReputationMax,
} from './node/reputation_sync.mjs'
import { getRoutingProfile, setRoutingProfile } from './node/routing_profile.mjs'
import { createScopedLinkRoom } from './rooms/scoped_link.mjs'
import { createGroupLinkSet } from './transport/group_link_set.mjs'
import {
	configureLinkRegistry,
	ensureLinkToNode,
	ensureOverlayRouter,
	getLinkRegistry,
	reloadDiscoveryRelays,
	sendToNodeLink,
} from './transport/link_registry.mjs'
import {
	attachUserRoomDefaultWires,
	ensureNodeScope,
	ensureUserRoom,
	getUserRoomSlot,
} from './transport/user_room.mjs'

/**
 * 包门面：节点、infra、mesh/registry、信誉同步、node-scope 等公开导出。
 */
export {
	attachReputationSyncWire,
	attachUserRoomDefaultWires,
	configureLinkRegistry,
	createGroupLinkSet,
	createScopedLinkRoom,
	ensureLinkToNode,
	ensureNodeDefaults,
	ensureNodeScope,
	ensureOverlayRouter,
	ensureUserRoom,
	getLinkRegistry,
	getNodeDir,
	getNodeHash,
	getReputationExportAllowlist,
	getReputationLocks,
	getReputationTable,
	getRoutingProfile,
	getTrustSyncDonors,
	getUserRoomSlot,
	initNode,
	isInfraRunning,
	isNodeInitialized,
	lockReputationMax,
	pullReputationFromNode,
	registerDiscoveryProvider,
	registerLinkProvider,
	reloadDiscoveryRelays,
	sendToNodeLink,
	setConnectivityDebug,
	setInfraPriority,
	setNodeLogger,
	setReputationExportAllowlist,
	setReputationTable,
	setRoutingProfile,
	setSignalingRuntimeConfig,
	setTrustSyncDonors,
	startInfra,
	stopInfra,
	unlockReputationMax,
}

/**
 * @param {{ nodeDir?: string, entityStore?: import('./node/entity_store.mjs').EntityStore, logger?: object | null, signaling?: import('./node/signaling_config.mjs').SignalingRuntimeConfig }} [options] - 首次 init 时的节点选项
 * @returns {Promise<void>}
 */
export async function startNode(options = {}) {
	if (!isNodeInitialized()) {
		const { nodeDir, entityStore, logger, signaling, ...rest } = options
		if (Object.keys(rest).length)
			throw new Error('p2p: startNode unknown options')
		initNode({ nodeDir, entityStore })
		if (logger !== undefined) setNodeLogger(logger)
		if (signaling !== undefined) setSignalingRuntimeConfig(signaling)
	}
	else if (options?.nodeDir || options?.entityStore || options?.logger !== undefined || options?.signaling)
		throw new Error('p2p: startNode options ignored after initNode — use setNodeLogger / setSignalingRuntimeConfig')

	ensureNodeDefaults()
	await getLinkRegistry().ensureRuntime()
}
