import { registerHooks } from 'node:module'

const shimUrl = new URL('./unenv_crypto_shim.mjs', import.meta.url).href

registerHooks({
	/**
	 *
	 * @param specifier
	 * @param context
	 * @param nextResolve
	 */
	resolve(specifier, context, nextResolve) {
		if (specifier === 'node:crypto' || specifier === 'crypto')
			return { shortCircuit: true, url: shimUrl, format: 'module' }
		return nextResolve(specifier, context)
	},
})
