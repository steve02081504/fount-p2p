/**
 * 在 unenv crypto shim 下调用 logicalEntityHash（供子进程探针使用）。
 */
import { logicalEntityHash } from '../../core/logical_entity.mjs'

const hash = logicalEntityHash('fount:chat:group:test')
if (typeof hash !== 'string' || hash.length !== 128)
	throw new Error(`unexpected hash: ${hash}`)
console.log(hash)
