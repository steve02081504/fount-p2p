/**
 * 等待 data channel open/close（re-export）。
 */
export { waitForChannelState } from './channel.mjs'
/**
 * ICE candidate 本地主机名策略（re-export）。
 */
export {
	applyIceLocalHostnamePolicy,
	filterIceLocalHostnameCandidate,
	wrapRtcPeerConnectionForIceLocalHostname,
} from './ice_local_hostname.mjs'
/**
 * Node WebRTC polyfill 加载（re-export）。
 */
export { clearNodeRtcPolyfillCache, loadNodeRtcPolyfill } from './polyfill.mjs'
