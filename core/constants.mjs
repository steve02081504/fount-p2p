import trustGraphTunables from '../trust_graph/tunables.json' with { type: 'json' }

/**
 * 占位 `message` 无 `message_edit` 终稿时的空闲截断（毫秒）；§6.4 `streamGeneratingIdleMs` 默认。
 */
export const DEFAULT_STREAM_GENERATING_IDLE_MS = 150_000
/**
 * 默认最大捕获事件数
 */
export const DEFAULT_MAX_CATCHUP_EVENTS = 50_000
/**
 * 成员页面大小
 */
export const MEMBERS_PAGE_SIZE = 500
/** Checkpoint 中保留的 epoch 链历史条数上限 */
export const EPOCH_CHAIN_MAX = 256

/** 群文件经联邦复制的单块上限（字节，§10.2） */
export const FEDERATION_CHUNK_MAX_BYTES = trustGraphTunables.federationChunkMaxBytes

/** 全局 fed_chunk_get miss 时 fanout 邻居数 */
export const FEDERATION_CHUNK_FETCH_FANOUT_K = trustGraphTunables.federationChunkFetchFanoutK
