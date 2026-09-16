import { setNostrRelayDiscoveryEnabledForTests } from '../../discovery/nostr/relays.mjs'
import { closeNode, initNode, setP2PFeatures } from '../../node/instance.mjs'
import { resetLinkRegistryForTests } from '../../transport/link_registry.mjs'
import {
	createDefaultTrustGraphProvider,
	DEFAULT_TRUST_GRAPH_OWNER,
	registerTrustGraphProvider,
} from '../../trust_graph/registry.mjs'

/**
 * 测试/headless 最小 node 初始化：initNode + 默认 trust graph provider。
 * 单测环境禁用 NIP-66 发现与 census（避免触发公网）。
 * @param {Parameters<typeof initNode>[0]} options initNode 选项
 * @returns {ReturnType<typeof initNode>} 节点运行时
 */
export function initTestP2pNode(options) {
	closeNode()
	resetLinkRegistryForTests()
	setNostrRelayDiscoveryEnabledForTests(false)
	const runtime = initNode(options)
	setP2PFeatures({ census: false })
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, createDefaultTrustGraphProvider())
	return runtime
}
