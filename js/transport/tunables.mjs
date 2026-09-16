import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** @type {object | null} */
let cache = null

/**
 * 读取 transport/tunables.json（进程内缓存）。
 * @returns {object} transport/tunables.json
 */
export function loadTransportTunables() {
	if (cache) return cache
	cache = JSON.parse(readFileSync(join(__dirname, 'tunables.json'), 'utf8'))
	return cache
}
