/**
 * 权限位掩码编解码（re-export）。
 */
export { createPermissionCodec } from './bitmask.mjs'
/**
 * 角色 deny/allow 覆盖合并（re-export）。
 */
export { applyDenyAllowOverride, mergeRoleOverrides } from './layered.mjs'
/**
 * 分层权限求值器（re-export）。
 */
export { createLayeredEvaluator } from './evaluator.mjs'
