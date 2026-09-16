/** 本机落盘数据 revision：信任图等订阅方只读，store 不反向依赖 trust_graph。 */

let revision = 0

/**
 * 本机数据 revision +1（信任图等订阅方）。
 * @returns {void}
 */
export function bumpLocalDataRevision() {
	revision++
}

/**
 * @returns {number} 当前本机数据 revision
 */
export function getLocalDataRevision() {
	return revision
}

/**
 * 测试用：清零 revision。
 * @returns {void}
 */
export function resetLocalDataRevisionForTests() {
	revision = 0
}
