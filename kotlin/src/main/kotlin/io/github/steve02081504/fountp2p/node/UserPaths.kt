package io.github.steve02081504.fountp2p.node

import java.nio.file.Paths

/** @return P2P 邮箱存储转发 JSONL 路径 */
fun mailboxStorePath(): String = Paths.get(getNodeDir(), "mailbox", "store.jsonl").toString()
