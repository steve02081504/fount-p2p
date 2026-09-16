package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isSignatureHex128
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.verify
import io.github.steve02081504.fountp2p.dag.eventBodyForSign
import io.github.steve02081504.fountp2p.dag.signPayloadBytes

/**
 * Social / 时间线远程入站 ed25519 验签（sender 为 pubKeyHash，公钥来自 senderPubKey）。
 *
 * 与 JS 的 `async` 版本相比，本实现为同步纯函数（Kotlin 侧 Ed25519 验签为 JCA/BC 同步 API），
 * 行为一致。
 * @param event 含 signature、sender、senderPubKey 的签名事件
 * @return 验签是否通过
 */
fun verifyTimelineRemoteSignature(event: Map<String, Any?>?): Boolean {
	val map = event ?: return false
	val sender = isHex64(map["sender"]) ?: return false
	val signatureHex = isSignatureHex128(map["signature"]) ?: return false
	val pubKeyHex = isHex64(map["senderPubKey"]) ?: return false
	val publicKeyBytes = hexToBytes(pubKeyHex)
	if (pubKeyHash(publicKeyBytes) != sender) return false
	val signatureBytes = hexToBytes(signatureHex)
	return verify(signatureBytes, signPayloadBytes(eventBodyForSign(map)), publicKeyBytes)
}
