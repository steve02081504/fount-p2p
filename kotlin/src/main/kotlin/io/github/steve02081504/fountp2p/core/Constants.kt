package io.github.steve02081504.fountp2p.core

/**
 * 占位 `message` 无 `message_edit` 终稿时的空闲截断（毫秒）；§6.4 `streamGeneratingIdleMs` 默认。
 */
const val DEFAULT_STREAM_GENERATING_IDLE_MS: Long = 150_000

/** 默认最大捕获事件数 */
const val DEFAULT_MAX_CATCHUP_EVENTS: Long = 50_000

/** 成员页面大小 */
const val MEMBERS_PAGE_SIZE: Long = 500

/** Checkpoint 中保留的 epoch 链历史条数上限 */
const val EPOCH_CHAIN_MAX: Long = 256

/** 群文件经联邦复制的单块上限（字节，§10.2） */
const val FEDERATION_CHUNK_MAX_BYTES: Long = 524288

/** 全局 fed_chunk_get miss 时 fanout 邻居数 */
const val FEDERATION_CHUNK_FETCH_FANOUT_K: Long = 6
