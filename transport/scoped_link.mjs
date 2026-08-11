import { createGroupLinkSet } from '../transport/group_link_set.mjs'

/**
 * scoped 房间：group_link_set 的薄预设（任意 scope + allowNode + 发现即拨）。
 * @param {object} options - 房间选项
 * @param {string} options.scope - link registry scope
 * @param {string} options.roomSecret - rendezvous 密钥
 * @param {(nodeHash: string) => boolean} [options.allowNode] - 节点准入过滤
 * @returns {ReturnType<typeof createGroupLinkSet>} scoped link 房间句柄
 */
export function createScopedLinkRoom(options) {
	const { scope, roomSecret, allowNode } = options
	return createGroupLinkSet({
		groupId: scope,
		scope,
		roomSecret,
		members: [],
		allowNode,
		dialAll: true,
		autoconnect: true,
	})
}
