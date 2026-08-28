import { access } from 'node:fs/promises'

import { where_command } from '@steve02081504/exec'

const COMMON_WINDOWS_PATHS = [
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

const COMMAND_NAMES = [
	'chrome.exe',
	'chrome',
	'msedge.exe',
	'msedge',
	'google-chrome',
	'google-chrome-stable',
	'chromium',
]

/** @type {string | null} */
let cachedPath = null

/**
 * 经 PATH（where_command）查找本机 Chrome/Chromium；找不到时尝试 Windows 常见安装路径。
 * @returns {Promise<string | null>} 可执行文件绝对路径或 null
 */
export async function resolveLocalChrome() {
	if (cachedPath) return cachedPath
	for (const name of COMMAND_NAMES) {
		const found = await where_command(name)
		if (found) {
			cachedPath = found
			return cachedPath
		}
	}
	for (const candidate of COMMON_WINDOWS_PATHS) 
		try {
			await access(candidate)
			cachedPath = candidate
			return cachedPath
		}
		catch { /* continue */ }
	
	return null
}