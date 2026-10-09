#!/usr/bin/env node
/**
 * 回归测试反证器：在游离 worktree 里把修复退回，确认「声称守住该 bug」的测试真的会失败。
 *
 * 为什么要有这个工具：修完之后再补的测试，在坏代码上静默通过的概率比看上去高得多
 * （断言写错、前置条件先炸、根本没走到那行）。人工跑一遍上面那套 worktree 流程既慢又容易错。
 *
 * 流程（每一步都在 worktree 里，绝不碰当前工作区）：
 *  1. `git worktree add --detach <临时目录> HEAD`。
 *  2. 为 `<临时目录>/js/node_modules` 建到主检出 `js/node_modules` 的目录联接（Windows `mklink /J`，
 *     其余平台 symlink）——不复制依赖，避免无意义的时间和磁盘开销。
 *  3. 把 `--tests` 指定的测试文件按仓库内相对路径复制进 worktree（未跟踪的新测试也在其中）。
 *  4. 用 `git restore --source=<--base> -- <--revert 的文件>` 退回修复。刻意不用
 *     `git checkout HEAD -- <path>`：那条命令同时写工作区，一旦在别处误用就会抹掉未暂存的改动。
 *  5. 在 worktree 里跑这些测试，要求**每一个叶子用例都因断言失败**：跑通（exit 0）、加载/语法错误、
 *     有用例通过或被跳过，都不算反证成立——判据是「失败」必须来自断言本身，而不是前置条件先炸。
 *  6. 先删掉目录联接，再删 worktree；`--keep` 时保留现场供人工查看。
 *
 * `--base` 要指向**还没有该修复**的提交（默认 `HEAD~1`；修复跨多个提交时给它更早的提交）。
 *
 * 退出码：0 = 每个测试都在退回去的代码上、且仅因断言失败而失败（反证成立）；1 = 退回后仍通过、
 * 失败不是断言、用例被跳过/取消，或测试文件根本跑不起来（会在 stderr 打印计数便于核对）。
 *
 * 用法（在 `js/` 或仓库根下都能跑）：
 *   node js/scripts/check-regression-guard.mjs --revert js/discovery/nostr/session.mjs \
 *     --tests js/test/pure/nostr_publish_listeners.test.mjs --base HEAD~1
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件所在包目录（`js/`） */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** @returns {string} 仓库根（`js/` 的父目录） */
function repoRoot() {
	const result = spawnSync('git', ['-C', PACKAGE_ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
	if (result.status !== 0) throw new Error(`not a git repository: ${PACKAGE_ROOT}`)
	return result.stdout.trim()
}

/**
 * 把命令行参数解析成仓库内相对路径：先后按「相对当前工作目录」再按「相对仓库根」试，
 * 两者都不存在即报错（写错路径要立刻炸，而不是在 worktree 里才炸）。
 * @param {string} target 绝对或相对路径
 * @param {string} root 仓库根
 * @returns {string} 相对仓库根的路径（正斜杠）
 */
function repoRelative(target, root) {
	const prefix = resolve(root) + sep
	for (const base of [process.cwd(), resolve(root)]) {
		const absolute = resolve(base, target)
		if (absolute.startsWith(prefix) && existsSync(absolute)) return absolute.slice(prefix.length).replaceAll('\\', '/')
	}
	throw new Error(`${target} does not name an existing file inside the repository ${root}`)
}

/**
 * 跑一条 git 命令，失败即抛出。
 * @param {string[]} args 参数
 * @param {string} cwd 工作目录
 * @returns {string} stdout
 */
function git(args, cwd) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
	if (result.status !== 0)
		throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`)
	return result.stdout
}

/**
 * 把 worktree 的 `js/node_modules` 指向主检出。
 * @param {string} worktree 临时 worktree 目录
 * @param {string} root 仓库根
 * @returns {void}
 */
function linkNodeModules(worktree, root) {
	const source = join(root, 'js', 'node_modules')
	if (!existsSync(source)) throw new Error(`missing dependencies: ${source} (run npm install in js/)`)
	const linkPath = join(worktree, 'js', 'node_modules')
	mkdirSync(dirname(linkPath), { recursive: true })
	if (process.platform === 'win32')
		spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, source], { stdio: 'inherit' })
	else
		spawnSync('ln', ['-s', source, linkPath], { stdio: 'inherit' })
	if (!existsSync(linkPath)) throw new Error(`failed to link ${linkPath}`)
}

/**
 * 删除目录联接/软链。必须用非递归删除，否则会把主检出真身一起删掉。
 * @param {string} worktree 临时 worktree 目录
 * @returns {void}
 */
function unlinkNodeModules(worktree) {
	const linkPath = join(worktree, 'js', 'node_modules')
	if (!existsSync(linkPath)) return
	if (!lstatSync(linkPath).isSymbolicLink()) throw new Error(`refusing to remove non-link ${linkPath}`)
	if (process.platform === 'win32') rmdirSync(linkPath)
	else rmSync(linkPath, { force: true })
}

/**
 * @param {string[]} argv 命令行参数
 * @returns {{ revert: string[], tests: string[], base: string, keep: boolean }} 解析结果
 */
function parseArgs(argv) {
	const options = { revert: [], tests: [], base: 'HEAD~1', keep: false }
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === '--keep') options.keep = true
		else if (arg === '--revert') options.revert.push(argv[++index])
		else if (arg === '--tests') options.tests.push(argv[++index])
		else if (arg === '--base') options.base = argv[++index]
		else throw new Error(`unknown argument: ${arg}`)
	}
	if (!options.revert.length || !options.tests.length)
		throw new Error('usage: check-regression-guard.mjs --revert <fixed file>... --tests <test file>... [--base <pre-fix commit>] [--keep]')
	return options
}

/**
 * 测试文件相对包目录（`js/`）的路径，即 `node --test` 要吃的形式。
 * @param {string} relative 相对仓库根的路径
 * @returns {string} 相对 `js/` 的路径
 */
function packageRelative(relative) {
	if (!relative.startsWith('js/')) throw new Error(`${relative} is not a test under js/`)
	return relative.slice('js/'.length)
}

const options = parseArgs(process.argv.slice(2))
const root = repoRoot()
const worktree = mkdtempSync(join(tmpdir(), 'fount-p2p-regression-guard-'))
let failures = 0

try {
	git(['worktree', 'add', '--detach', worktree, 'HEAD'], root)
	linkNodeModules(worktree, root)
	for (const testFile of options.tests) {
		const relative = repoRelative(testFile, root)
		cpSync(join(root, relative), join(worktree, relative))
	}
	for (const fixedFile of options.revert) git(['restore', '--source=' + options.base, '--', repoRelative(fixedFile, root)], worktree)
	for (const testFile of options.tests) {
		const relative = repoRelative(testFile, root)
		console.log(`\n=== ${relative} on the pre-fix code (must fail) ===`)
		// 本工具本身可能就跑在 node:test 里（它的自测就是）：若把 `NODE_TEST_CONTEXT` 传下去，
		// 子进程会判定成「测试文件里递归调用 run()」而跳过整个文件，于是「跳过」被当成「测试通过」，
		// 反证器会给出假阴性。清掉测试上下文，让子进程是干净的一级 runner。
		const env = { ...process.env }
		delete env.NODE_TEST_CONTEXT
		delete env.NODE_TEST_WORKER_ID
		const result = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=tap', packageRelative(relative)], {
			cwd: join(worktree, 'js'),
			env,
			encoding: 'utf8',
			// TAP 会带上每个失败用例的诊断与堆栈：留足缓冲，别让大输出变成 ENOBUFS 的假阴性。
			maxBuffer: 64 * 1024 * 1024,
		})
		process.stdout.write(result.stdout || '')
		process.stderr.write(result.stderr || '')
		// 只有每个叶子用例都因断言失败才算反证成立；加载/语法错误和混合通过不能冒充回归断言。
		const report = result.stdout || ''
		/**
		 * 取 TAP 报告里某个计数行（`# tests 3`、`# pass 2` …）。
		 * @param {string} name 计数项名（tests / pass / fail / skipped / cancelled / todo）
		 * @returns {number} 该项计数，缺失时为 0
		 */
		const count = name => Number(report.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] || 0)
		const total = count('tests')
		const passed = count('pass')
		const failed = count('fail')
		const notRun = count('skipped') + count('cancelled') + count('todo')
		const assertions = [...report.matchAll(/^\s+code: 'ERR_ASSERTION'$/gm)].length
		const summary = `tests=${total} pass=${passed} fail=${failed} skipped/cancelled/todo=${notRun} assertionFailures=${assertions} exit=${result.status}`
		if (result.error) {
			console.error(`!! ${relative} could not be run: ${result.error.message}`)
			failures++
		}
		else if (result.status === 0) {
			console.error(`!! ${relative} still passes on the pre-fix code — it does not guard the fix (${summary})`)
			failures++
		}
		else if (result.status !== 1 || failed === 0 || passed || notRun || total !== failed || assertions !== failed) {
			console.error(`!! ${relative} did not fail exclusively through regression assertions (${summary})`)
			failures++
		}
	}
}
finally {
	unlinkNodeModules(worktree)
	if (options.keep) console.log(`\nkept worktree: ${worktree}`)
	else git(['worktree', 'remove', '--force', worktree], root)
}

process.exit(failures ? 1 : 0)
