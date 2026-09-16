package io.github.steve02081504.fountp2p.node

/** 本机落盘数据 revision：信任图等订阅方只读，store 不反向依赖 trust_graph。 */

private var revision = 0.0

/** 本机数据 revision +1（信任图等订阅方）。 */
fun bumpLocalDataRevision() {
	revision++
}

/** @return 当前本机数据 revision */
fun getLocalDataRevision(): Double = revision

/** 测试用：清零 revision。 */
fun resetLocalDataRevisionForTests() {
	revision = 0.0
}
