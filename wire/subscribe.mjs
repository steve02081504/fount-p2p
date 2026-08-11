/**
 * 批量注册 wire action，返回统一 dispose。
 * @param {import('./adapter.mjs').WireAdapter} wire action 表
 * @param {Record<string, (payload: unknown, peerId: string) => void>} handlers action → handler
 * @returns {() => void} 取消全部注册
 */
export function subscribeWire(wire, handlers) {
	const offs = Object.entries(handlers).map(([name, handler]) => wire.on(name, handler))
	return () => {
		for (const off of offs)
			try { off?.() } catch { /* ignore */ }
	}
}
