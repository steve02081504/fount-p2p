/**
 * @typedef {{
 *   on: (name: string, handler: (payload: unknown, peerId: string) => void) => (() => void) | void
 *   send: (name: string, payload: unknown, peerId: string | null) => void
 * }} WireAdapter
 */

/**
 * @typedef {{ replicaUsername?: string }} WireContext
 */

/** Wire 适配器与上下文的类型导出（运行时代码见各 wire 模块）。 */
export {}
