package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.transport.node_scope.attachNodeScopeFeature
import io.github.steve02081504.fountp2p.transport.sendToNodeLink
import kotlinx.coroutines.*
import java.security.SecureRandom

/** 挑战超时上限（与 `node/verification.mjs` 的 `MAX_TIMEOUT` 一致）。 */
private const val MAX_VERIFICATION_TIMEOUT_MS = 1_800_000L

/** 同时挂起的验证请求上限。 */
private const val MAX_PENDING_PROOFS = 64

/** 已发出的挑战记录上限。 */
private const val MAX_PENDING_REQUESTS = 1024

/** 过期挑战记录保留时长。 */
private const val REQUEST_RETENTION_MS = 60_000L

/** 单次验证等待回执的最长时间。 */
private const val RECEIPT_WAIT_MS = 15_000L

/** 请求方解析出的截止时间：非数字返回 null。 */
private fun expiresAtOf(payload: Map<String, Any?>): Long? = (payload["expiresAt"] as? Number)?.toLong()

/**
 * 有界、一次性的网络验证挑战服务，等价 `node/verification.mjs`。
 *
 * 发送方身份一律取自已认证的网络入口，不信任载荷自称。
 */
class NetworkVerificationService(
    private val nodeHash: String,
    private val send: suspend (String, String, Map<String, Any?>) -> Boolean,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val requests = LinkedHashMap<String, MutableMap<String, Any?>>()
    private data class Proof(val requester: String, val expires: Long, val result: CompletableDeferred<Map<String, Any?>>)
    private val proofs = LinkedHashMap<String, Proof>()
    private val lock = Any()

    /** 清理已过期的挑战记录。 */
    private fun prune() {
        requests.entries.removeIf { (it.value["expiresAt"] as Long) + REQUEST_RETENTION_MS < now() }
    }

    /** 取挑战快照，并把已过期的 pending 收敛为 failed。 */
    private fun snapshot(entry: MutableMap<String, Any?>): Map<String, Any?> {
        if (entry["status"] == "pending" && now() >= (entry["expiresAt"] as Long)) {
            entry["status"] = "failed"; entry["reason"] = "timeout"
        }
        return LinkedHashMap(entry)
    }

    /**
     * 新建一个挑战：限幅超时、限制在途数量，返回待验证快照。
     * @param timeoutMs 超时毫秒
     * @return 待验证快照
     */
    fun create(timeoutMs: Long = 300_000L): Map<String, Any?> = synchronized(lock) {
        require(timeoutMs in 1..MAX_VERIFICATION_TIMEOUT_MS) { "invalid timeoutMs" }
        prune()
        check(requests.size < MAX_PENDING_REQUESTS) { "too many verification requests" }
        val challenge = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val entry = linkedMapOf<String, Any?>("challenge" to challenge, "requesterNodeHash" to nodeHash, "expiresAt" to (now() + timeoutMs), "status" to "pending")
        requests[challenge] = entry
        snapshot(entry)
    }

    /**
     * 按挑战串读取快照；不存在返回 null。
     * @param challenge 挑战串
     * @return 快照，未知挑战为 null
     */
    fun get(challenge: String): Map<String, Any?>? = synchronized(lock) { prune(); requests[challenge]?.let(::snapshot) }

    /**
     * 处理入站 verification_claim / verification_receipt 动作。
     * @param action 网络动作
     * @param payload 网络载荷
     * @param sender 已认证身份
     */
    suspend fun receive(action: String, payload: Map<String, Any?>, sender: String) {
        if (isHex64(sender) == null || isHex64(payload["challenge"]) == null) return
        val challenge = payload["challenge"] as String
        val expires = expiresAtOf(payload) ?: return
        if (action == "verification_claim") {
            val receipt = synchronized(lock) {
                val entry = requests[challenge] ?: return@synchronized null
                if (now() >= (entry["expiresAt"] as Long) || entry["expiresAt"] != expires || snapshot(entry)["status"] == "failed") return@synchronized null
                if (entry["status"] == "verified" && entry["nodeHash"] != sender) return@synchronized null
                entry["status"] = "verified"; entry["nodeHash"] = sender
                linkedMapOf<String, Any?>("challenge" to challenge, "expiresAt" to expires)
            }
            if (receipt != null) send(sender, "verification_receipt", receipt)
        }
        if (action == "verification_receipt") synchronized(lock) {
            val proof = proofs[challenge]
            if (proof != null && proof.requester == sender && proof.expires == expires && now() < proof.expires)
                proof.result.complete(mapOf("status" to "verified", "nodeHash" to nodeHash))
        }
    }

    /**
     * 向请求方发起验证并等待回执（去重、并发上限、超时收敛为 failed）。
     * @param request 挑战请求
     * @return 验证结果
     */
    suspend fun prove(request: Map<String, Any?>): Map<String, Any?> {
        val requester = isHex64(request["requesterNodeHash"])
        val challenge = isHex64(request["challenge"])
        val expires = expiresAtOf(request)
        if (requester == null || challenge == null || expires == null || expires <= now() || expires > now() + MAX_VERIFICATION_TIMEOUT_MS)
            return mapOf("status" to "failed", "reason" to "invalid challenge")
        val (proof, existing) = synchronized(lock) {
            val prior = proofs[challenge]
            if (prior != null) return@synchronized prior to true
            if (proofs.size >= MAX_PENDING_PROOFS) return mapOf("status" to "failed", "reason" to "busy")
            val created = Proof(requester, expires, CompletableDeferred())
            proofs[challenge] = created
            created to false
        }
        if (proof.requester != requester || proof.expires != expires) return mapOf("status" to "failed", "reason" to "challenge mismatch")
        if (existing) return proof.result.await()
        return coroutineScope {
            val sending = launch {
                try {
                    if (!send(requester, "verification_claim", mapOf("challenge" to challenge, "expiresAt" to expires)))
                        proof.result.complete(mapOf("status" to "failed", "reason" to "unreachable"))
                } catch (_: Exception) { proof.result.complete(mapOf("status" to "failed", "reason" to "unreachable")) }
            }
            try {
                val result = withTimeoutOrNull(minOf(expires - now(), RECEIPT_WAIT_MS)) { proof.result.await() }
                if (result != null) result else {
                    val failure = mapOf<String, Any?>("status" to "failed", "reason" to "timeout")
                    proof.result.complete(failure)
                    failure
                }
            }
            finally { sending.cancel(); synchronized(lock) { proofs.remove(challenge) } }
        }
    }
}

/**
 * @param nodeHash 本节点身份
 * @param send 经已认证链路投递验证消息
 * @param now 当前时间毫秒
 * @return 验证服务
 */
fun createNetworkVerificationService(
    nodeHash: String,
    send: suspend (String, String, Map<String, Any?>) -> Boolean,
    now: () -> Long = System::currentTimeMillis,
): NetworkVerificationService = NetworkVerificationService(nodeHash, send, now)

private var verificationService: NetworkVerificationService? = null
private val verificationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * 取当前节点的验证服务（懒创建单例）。
 * @return 验证服务
 */
fun getNetworkVerificationService(): NetworkVerificationService {
    verificationService?.let { return it }
    val created = NetworkVerificationService(
        getNodeHash(),
        { peer, action, payload ->
            if (peer == getNodeHash()) { getNetworkVerificationService().receive(action, payload, peer); true }
            else sendToNodeLink(peer, mapOf("scope" to "node", "action" to action, "payload" to payload))
        },
    )
    verificationService = created
    return created
}

/**
 * 把验证动作挂到正在运行的节点的 node scope 上。
 * @return 卸载 dispose
 */
fun attachNetworkVerification(): () -> Unit = attachNodeScopeFeature("verification", { wire, _ ->    val current = getNetworkVerificationService()
    val disposers: List<(() -> Unit)?> = listOf("verification_claim", "verification_receipt").map { action ->
        wire.on(action) { payload, sender ->
            @Suppress("UNCHECKED_CAST") val body = payload as? Map<String, Any?>
            if (body != null) verificationScope.launch { runCatching { current.receive(action, body, sender) } }
        }
    }
    val dispose: () -> Unit = {
        for (disposeAction in disposers) disposeAction?.invoke()
        verificationService = null
    }
    dispose
})

/**
 * 单次自证：证明本节点可达请求方并收到其回执。
 * @param request 挑战请求
 * @return 验证结果
 */
suspend fun proveNetworkVerification(request: Map<String, Any?>): Map<String, Any?> {
    val dispose = attachNetworkVerification()
    try { return getNetworkVerificationService().prove(request) } finally { dispose() }
}
