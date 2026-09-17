package io.github.steve02081504.fountp2p.transport

/**
 * scoped 房间：`group_link_set` 的薄预设（任意 scope + allowNode + 发现即拨）。
 * 等价 `js/transport/scoped_link.mjs`。
 */

/** [createScopedLinkRoom] 选项。 */
class ScopedLinkRoomOptions(
	val scope: String,
	val roomSecret: String,
	val allowNode: ((nodeHash: String) -> Boolean)? = null,
)

/**
 * @param options 房间选项
 * @return scoped link 房间句柄
 */
fun createScopedLinkRoom(options: ScopedLinkRoomOptions): GroupLinkSet =
	createGroupLinkSet(
		options.scope,
		GroupLinkSetOptions(
			scope = options.scope,
			roomSecret = options.roomSecret,
			members = emptyList(),
			allowNode = options.allowNode,
			dialAll = true,
			autoconnect = true,
		),
	)
