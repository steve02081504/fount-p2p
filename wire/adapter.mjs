/**
 * @typedef {{
 *   on: (name: string, handler: (payload: unknown, peerId: string) => void) => (() => void) | void
 *   send: (name: string, payload: unknown, peerId: string | null) => void
 * }} WireAdapter
 */

/**
 * @typedef {{ replicaUsername?: string }} WireContext
 */

/**
 *
 */
export {}
