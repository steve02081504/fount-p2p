/** 三级集合与 Nostr relay 池的硬限制常量。 */

/** 池最大条目数。 */
export const POOL_CAP = 300
/** 工作集大小（健康分最优前 N）。 */
export const WORKING_RELAYS_COUNT = 32
/** 监听/发布子集大小（含所有 public/manual）。 */
export const LISTEN_RELAYS_COUNT = 24
/** advert 中 pool 最大条目。 */
export const MAX_ADVERT_RELAY_POOL = 16
/** advert 中 listen 最大条目。 */
export const MAX_ADVERT_LISTEN_RELAYS = 32
/** 每轮路由最大目标数。 */
export const MAX_ROUTING_FANOUT = 64
/** 最大路由重试轮数。 */
export const MAX_ROUTING_ATTEMPTS = 4
/** round 0 / 核心集目标 relay 数。 */
export const ROUND0_TARGET_COUNT = 4
/** lastGoodNostrRelays / 历史扩展上限。 */
export const LAST_GOOD_RELAYS_MAX = 16
/** 失败率惩罚因子。 */
export const FAILURE_WEIGHT = 4
/** 过时探测惩罚倍数。 */
export const STALE_PENALTY = 2
/** NIP-66 刷新间隔。 */
export const NIP66_REFRESH_MS = 6 * 3600 * 1000
/** 超过此时间未探测视为 stale。 */
export const PROBE_STALE_MS = 24 * 3600 * 1000
/** 路由退避基数。 */
export const BACKOFF_BASE_MS = 2000
/** 路由退避上限。 */
export const BACKOFF_CAP_MS = 60000
/** 有效 RTT 上限。 */
export const MAX_RTT_MS = 60000
/** 缺失 RTT 默认值。 */
export const DEFAULT_RTT_MS = 300

/** NIP-66 专用引导中继（kind 30166 发现源）。 */
export const NIP66_BOOTSTRAP_RELAYS = [
	'wss://relay.nostr.watch',
	'wss://relaypag.es',
	'wss://monitorlizard.nostr1.com',
]
