import config from 'https://cdn.jsdelivr.net/gh/steve02081504/my-eslint-config/deno.mjs'
/**
 * ESLint 配置（复用全局共享配置，仅追加本仓库忽略项）。
 * @type {import('eslint').Linter.FlatConfig[]}
 */
export default [
	// kotlin/build 是 Gradle 测试报告自动生成的产物，不入库也不该被 lint。
	{ ignores: ['kotlin/build/**'] },
	...config,
]
