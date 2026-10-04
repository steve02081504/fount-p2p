/**
 * 仓库文件遍历（只列仓库内文件：已跟踪 + 未跟踪但未被忽略，已删除文件除外；尊重嵌套 gitignore）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 经 git 列出工作区文件。
 * @param {string} repoRoot 仓库根
 * @returns {Promise<string[]>} 相对路径（正斜杠、已排序）
 */
async function listViaGit(repoRoot) {
	const [listed, deleted] = await Promise.all([
		run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }),
		run('git', ['ls-files', '-z', '--deleted'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }),
	])
	const parse = chunk => String(chunk).split('\0').filter(Boolean)
	const deletedPaths = new Set(parse(deleted.stdout))
	return parse(listed.stdout).filter(path => !deletedPaths.has(path)).map(path => path.replaceAll('\\', '/')).sort()
}

/**
 * 收集匹配后缀的文件（相对仓库根、正斜杠、已排序）。
 * @param {string} repoRoot 仓库根
 * @param {string[]} [suffixes] 后缀（如 `.md`）；空/缺省=全部
 * @returns {Promise<string[]>} 相对路径列表
 */
export async function listRepoFiles(repoRoot, suffixes) {
	const files = await listViaGit(repoRoot)
	if (!suffixes?.length) return files
	return files.filter(path => suffixes.some(suffix => path.endsWith(suffix)))
}
