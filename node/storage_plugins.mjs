import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 群组分块存储插件：put/get/delete + 不透明 storageLocator。
 * S3、多副本等后端由 shell 注入实现，本包只提供本地参考实现。
 *
 * @typedef {{
 *   putChunk: (groupId: string, chunkHash: string, data: Uint8Array) => Promise<{ storageLocator: string }>,
 *   getChunk: (locator: string) => Promise<Uint8Array>,
 *   deleteChunk: (locator: string) => Promise<void>,
 * }} GroupStoragePlugin
 */

/**
 * @param {unknown} error 存储删除错误
 * @returns {boolean} 是否为「文件不存在」
 */
function isEnoent(error) {
	return /** @type {{ code?: string }} */ error?.code === 'ENOENT'
}

/**
 * 默认：本地目录 {baseDir}/groups/{groupId}/chunks/（baseDir 一般为用户 shells/chat）
 *
 * @param {string} baseDir 绝对路径
 * @returns {GroupStoragePlugin} 本地文件系统实现的 put/get/delete
 */
export function createLocalStoragePlugin(baseDir) {
	return {
		storagePeerId: 'local',
		/**
		 * @param {string} groupId 群组 id
		 * @param {string} chunkHash 分块内容哈希（文件名）
		 * @param {Uint8Array} data 原始字节
		 * @returns {Promise<{ storageLocator: string }>} `local:` 前缀的定位符
		 */
		async putChunk(groupId, chunkHash, data) {
			const dir = join(baseDir, 'groups', groupId, 'chunks')
			await mkdir(dir, { recursive: true })
			const name = `${chunkHash}.bin`
			await writeFile(join(dir, name), data)
			return { storageLocator: `local:${groupId}/chunks/${name}` }
		},
		/**
		 * @param {string} locator `local:...` 格式
		 * @returns {Promise<Uint8Array>} 文件内容
		 */
		async getChunk(locator) {
			const localLocatorMatch = String(locator).match(/^local:([^/]+)\/chunks\/(.+)$/)
			if (!localLocatorMatch) throw new Error('Invalid local locator')
			const chunkPath = join(baseDir, 'groups', localLocatorMatch[1], 'chunks', localLocatorMatch[2])
			return new Uint8Array(await readFile(chunkPath))
		},
		/**
		 * @param {string} locator `local:...` 格式
		 * @returns {Promise<void>}
		 */
		async deleteChunk(locator) {
			const localLocatorMatch = String(locator).match(/^local:([^/]+)\/chunks\/(.+)$/)
			if (!localLocatorMatch) return
			const chunkPath = join(baseDir, 'groups', localLocatorMatch[1], 'chunks', localLocatorMatch[2])
			try {
				await unlink(chunkPath)
			}
			catch (error) {
				if (!isEnoent(error)) throw error
			}
		},
	}
}
