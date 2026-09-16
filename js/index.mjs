/**
 * Federation P2P 门面：fount 网络引导与房间/发现入口。
 */
import { registerDiscoveryProvider } from './discovery/index.mjs'
import { getNodePopulationEstimate } from './discovery/nostr/census.mjs'
import {
	isInfraRunning,
	setInfraPriority,
	startInfra,
	stopInfra,
} from './infra/service.mjs'
import { registerLinkProvider } from './link/providers/index.mjs'
import { ensureNodeDefaults, getNodeHash } from './node/identity.mjs'
import {
	closeNode,
	getNodeDir,
	getP2PFeatures,
	initNode,
	isNodeInitialized,
	setNodeLogger,
	setP2PFeatures,
	setSignalingRuntimeConfig,
} from './node/instance.mjs'
import { setConnectivityDebug } from './node/log.mjs'
import { loadReputation } from './node/reputation_store.mjs'
import {
	attachReputationSyncWire,
	getReputationExportAllowlist,
	getReputationLocks,
	getTrustSyncDonors,
	lockReputationMax,
	pullReputationFromNode,
	setReputationExportAllowlist,
	setReputationTable,
	setTrustSyncDonors,
	unlockReputationMax,
} from './node/reputation_sync.mjs'
import { getRoutingProfile, setRoutingProfile } from './node/routing_profile.mjs'
import { createGroupLinkSet } from './transport/group_link_set.mjs'
import {
	configureLinkRegistry,
	ensureChannelAvailable,
	ensureLinkToNode,
	ensureOverlayRouter,
	getLinkRegistry,
	getPeerHealth,
	listPeerHealth,
	onPeerHealth,
	reloadDiscoveryRelays,
	sendToNodeLink,
} from './transport/link_registry.mjs'
import { attachNodeScopeDefaultFeatures } from './transport/node_scope/features.mjs'
import { ensureNodeScope } from './transport/node_scope/wire.mjs'
import { createScopedLinkRoom } from './transport/scoped_link.mjs'
import {
	ensureUserRoom,
	getUserRoomSlot,
} from './transport/user_room.mjs'

/**
 * 包门面：节点、infra、mesh/registry、信誉同步、node-scope 等公开导出。
 */
export {
	attachReputationSyncWire,
	attachNodeScopeDefaultFeatures,
	closeNode,
	configureLinkRegistry,
	createGroupLinkSet,
	createScopedLinkRoom,
	ensureChannelAvailable,
	ensureLinkToNode,
	ensureNodeDefaults,
	ensureNodeScope,
	ensureOverlayRouter,
	ensureUserRoom,
	getLinkRegistry,
	getNodeDir,
	getNodeHash,
	getNodePopulationEstimate,
	getP2PFeatures,
	getPeerHealth,
	getReputationExportAllowlist,
	getReputationLocks,
	getRoutingProfile,
	getTrustSyncDonors,
	getUserRoomSlot,
	initNode,
	isInfraRunning,
	isNodeInitialized,
	listPeerHealth,
	loadReputation,
	lockReputationMax,
	onPeerHealth,
	pullReputationFromNode,
	registerDiscoveryProvider,
	registerLinkProvider,
	reloadDiscoveryRelays,
	sendToNodeLink,
	setConnectivityDebug,
	setInfraPriority,
	setNodeLogger,
	setP2PFeatures,
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
 * @param {{ nodeDir?: string, entityStore?: import('./node/entity_store.mjs').EntityStore, logger?: object | null, signaling?: import('./node/signaling_config.mjs').SignalingRuntimeConfig, features?: Record<string, boolean> }} [options] - 首次 init 时的节点选项
 * @returns {Promise<void>}
 */
export async function startNode(options = {}) {
	if (!isNodeInitialized()) {
		const { nodeDir, entityStore, logger, signaling, features, ...rest } = options
		if (Object.keys(rest).length)
			throw new Error('p2p: startNode unknown options')
		initNode({ nodeDir, entityStore })
		if (logger !== undefined) setNodeLogger(logger)
		if (signaling !== undefined) setSignalingRuntimeConfig(signaling)
		if (features !== undefined) setP2PFeatures(features)
	}
	else if (options?.nodeDir || options?.entityStore || options?.logger !== undefined || options?.signaling || options?.features)
		throw new Error('p2p: startNode options ignored after initNode — use setNodeLogger / setSignalingRuntimeConfig / setP2PFeatures')

	ensureNodeDefaults()
	await getLinkRegistry().ensureRuntime()
}
