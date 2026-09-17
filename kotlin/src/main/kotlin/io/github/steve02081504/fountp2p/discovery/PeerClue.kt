package io.github.steve02081504.fountp2p.discovery

private var peerClueListener: ((String) -> Unit)? = null

/**
 * 由 link registry 注入：peer 首次可见时清 dial 冷却。
 * @param listener 回调
 */
fun setDiscoveryPeerClueListener(listener: ((String) -> Unit)?) {
	peerClueListener = listener
}

/**
 * discovery accept 路径：peer 首次进入可见池时通知 registry。
 * @param nodeHash 对端
 */
fun noteDiscoveryPeerClue(nodeHash: String?) {
	if (!nodeHash.isNullOrEmpty()) peerClueListener?.invoke(nodeHash)
}
