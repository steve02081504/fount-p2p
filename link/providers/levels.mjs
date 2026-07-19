/**
 * LinkProvider level 约定：数值越大越优先（建链时降序尝试）。
 * Discovery 的 priority 仍为升序，两套语义故意分名。
 */
export const LINK_LEVEL_LAN_TCP = 80
/** WebRTC 链路 level。 */
export const LINK_LEVEL_WEBRTC = 70
/** BLE GATT 链路 level。 */
export const LINK_LEVEL_BLE_GATT = 40
