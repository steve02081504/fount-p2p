import { registerHooks } from 'node:module'

const shimUrl = new URL('./unenv_crypto_shim.mjs', import.meta.url).href

registerHooks({
	/**
	 * @param {string} specifier 模块标识符
	 * @param {import('node:module').ResolveHookContext} context 解析上下文
	 * @param {import('node:module').ResolveHookNext} nextResolve 下一钩子
	 * @returns {import('node:module').ResolveHookReturn} 解析结果
	 */
	resolve(specifier, context, nextResolve) {
		if (specifier === 'node:crypto' || specifier === 'crypto')
			return { shortCircuit: true, url: shimUrl, format: 'module' }
		return nextResolve(specifier, context)
	},
})
