package io.github.steve02081504.fountp2p.discovery.nostr

/** 三级集合与 Nostr relay 池的硬限制常量（等价 `discovery/nostr/constants.mjs`）。 */

/** 池最大条目数。 */
const val POOL_CAP = 300

/** 工作集大小（健康分最优前 N）。 */
const val WORKING_RELAYS_COUNT = 32

/** 监听/发布子集大小（含所有 public/manual）。 */
const val LISTEN_RELAYS_COUNT = 24

/** advert 中 pool 最大条目。 */
const val MAX_ADVERT_RELAY_POOL = 16

/** advert 中 listen 最大条目。 */
const val MAX_ADVERT_LISTEN_RELAYS = 32

/** 每轮路由最大目标数。 */
const val MAX_ROUTING_FANOUT = 64

/** 最大路由重试轮数。 */
const val MAX_ROUTING_ATTEMPTS = 4

/** round 0 / 核心集目标 relay 数。 */
const val ROUND0_TARGET_COUNT = 4

/** lastGoodNostrRelays / 历史扩展上限。 */
const val LAST_GOOD_RELAYS_MAX = 16

/** 失败率惩罚因子。 */
const val FAILURE_WEIGHT = 4

/** 过时探测惩罚倍数。 */
const val STALE_PENALTY = 2

/** NIP-66 刷新间隔。 */
const val NIP66_REFRESH_MS: Long = 6L * 3600 * 1000

/** 超过此时间未探测视为 stale。 */
const val PROBE_STALE_MS: Long = 24L * 3600 * 1000
/** 发布失败后的暂时避让窗口；到期后允许重新尝试发布。 */
const val PUBLISH_FAILURE_COOLDOWN_MS: Long = 30L * 60 * 1000

/** 路由退避基数。 */
const val BACKOFF_BASE_MS = 2000

/** 路由退避上限。 */
const val BACKOFF_CAP_MS = 60000

/** 有效 RTT 上限。 */
const val MAX_RTT_MS = 60000

/** 缺失 RTT 默认值。 */
const val DEFAULT_RTT_MS = 300

/** NIP-66 专用引导中继（kind 30166 发现源）。 */
val NIP66_BOOTSTRAP_RELAYS = listOf(
	"wss://relay.nostr.watch",
	"wss://relaypag.es",
	"wss://monitorlizard.nostr1.com",
)

/** 默认公共中继。 */
val DEFAULT_RELAY_URLS = listOf(
	"wss://relay.nostr.com",
	"wss://nos.lol",
	"wss://nostr.bitcoiner.social",
	"wss://nostr.mom",
	"wss://relay.snort.social",
	"wss://relay.primal.net",
)

/** Nostr census 事件 kind（每节点每窗口至多一条，按 nodeHash 去重）。 */
const val NOSTR_CENSUS_KIND = 30789

/** census 订阅/发布标签：`t=fount` + `x=census`。 */
const val CENSUS_TAG_FOUNT = "fount"

/** 见 [CENSUS_TAG_FOUNT]。 */
const val CENSUS_TAG_X = "census"
