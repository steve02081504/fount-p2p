package io.github.steve02081504.fountp2p.link.providers

/**
 * LinkProvider level 约定：数值越大越优先（建链时降序尝试）。
 * Discovery 的 priority 仍为升序，两套语义故意分名。
 */
const val LINK_LEVEL_LAN_TCP = 80.0

/** WebRTC 链路 level。 */
const val LINK_LEVEL_WEBRTC = 70.0

/** BLE GATT 链路 level。 */
const val LINK_LEVEL_BLE_GATT = 40.0

/** Nostr relay 末位数据链（仅其它传输失败后）。 */
val LINK_LEVEL_NOSTR = Double.NEGATIVE_INFINITY
