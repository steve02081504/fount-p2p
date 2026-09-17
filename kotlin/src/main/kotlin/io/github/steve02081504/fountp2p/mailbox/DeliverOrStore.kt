package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.node.getNodeTransportSettings
import io.github.steve02081504.fountp2p.transport.activeLinkRoster
import io.github.steve02081504.fountp2p.transport.deliverToUserRoomPeers
import io.github.steve02081504.fountp2p.trust_graph.DEFAULT_TRUST_GRAPH_OWNER
import io.github.steve02081504.fountp2p.trust_graph.requireTrustGraphProvider
import io.github.steve02081504.fountp2p.wire.WireContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Mailbox 存转发（等价 `js/mailbox/deliver_or_store.mjs`）。
 *
 * 依赖已移植的 `transport/user_room`（[activeLinkRoster] / [deliverToUserRoomPeers]）与
 * `trust_graph` provider（[requireTrustGraphProvider]）。
 */

/** 存转结果（等价 JS `{ stored, delivered, relayed }`）。 */
data class MailboxDeliverResult(
	val stored: Boolean,
	val delivered: Boolean,
	val relayed: Int,
)

/** 后台派发作用域（等价 JS `void ingest...().catch(...)`）。 */
private val mailboxDeliverScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * @param peerId Trystero 对端 id
 * @return 已验证的 remote nodeHash；无绑定为 null
 */
private fun resolveRemoteNodeHashForPeer(peerId: String): String? {
	if (peerId.isEmpty()) return null
	val entry = activeLinkRoster().firstOrNull { it.peerId == peerId } ?: return null
	val remote = entry.remoteNodeHash
	return if (!remote.isNullOrEmpty()) remote else null
}

/**
 * @param record 入站 record
 * @return 本节点应存储的 hop
 */
private suspend fun resolveRelayHopForIngress(record: Map<String, Any?>): Int {
	val id = try {
		mailboxEnvelopeId(record["envelope"])
	}
	catch (_: Throwable) {
		return relayHopAfterWireIngress(record["hop"])
	}
	val existing = getMailboxRecords(listOf(id)).firstOrNull()
	return relayHopAfterWireIngress(record["hop"], existing?.get("hop"))
}

/**
 * @param username 副本用户名
 * @return 按在线 peer 数缩放的路由
 */
private suspend fun resolveRouting(@Suppress("UNUSED_PARAMETER") username: String): Map<String, Any?> {
	val settings = getNodeTransportSettings()
	val batterySaver = jsTruthy(settings["batterySaver"])
	val mailbox = Json.obj(settings["mailbox"])
	val peerCount = activeLinkRoster().size
	return resolveMailboxRoutingForPeerCount(peerCount, mailbox, batterySaver)
}

/** @param routing 路由表 @param key 字段 @return 数值字段 */
private fun intAt(routing: Map<String, Any?>, key: String): Int =
	(routing[key] as? Number)?.toInt() ?: 0

/**
 * @param username 副本用户名（trust graph 投递上下文）
 * @param options 投递选项
 * @return 存转结果
 */
suspend fun deliverOrStoreMailboxPut(username: String, options: Map<String, Any?>): MailboxDeliverResult {
	val routing = resolveRouting(username)
	val toPubKeyHash = isHex64(options["toPubKeyHash"])
		?: return MailboxDeliverResult(stored = false, delivered = false, relayed = 0)
	val hop = normalizeMailboxHop(options["hop"])
	val maxHop = intAt(routing, "maxHop")
	if (hop >= maxHop) return MailboxDeliverResult(stored = false, delivered = false, relayed = 0)
	val tier = mailboxTierFromHop(hop)
	val nodeHash = getNodeHash()
	val sourceRecord = Json.obj(options["record"])
	val record = LinkedHashMap<String, Any?>()
	sourceRecord?.let { record.putAll(it) }
	record["toPubKeyHash"] = toPubKeyHash
	record["hop"] = hop.toDouble()
	record["tier"] = tier
	val recordFromNodeHash = sourceRecord?.get("fromNodeHash")
	record["fromNodeHash"] = if (jsTruthy(recordFromNodeHash)) recordFromNodeHash else nodeHash
	val stored = storeMailboxRecord(record)
	val toNodeHash = isHex64(options["toNodeHash"])
	val delivered = if (toNodeHash != null && isMailboxRecordWithinSizeLimit(record))
		requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER).sendToNode(
			username,
			toNodeHash,
			"mailbox_put",
			linkedMapOf("nodeHash" to nodeHash, "record" to record),
		)
	else false

	var relayed = 0
	val relayFanout =
		if (tier == "trusted") intAt(routing, "relayFanoutTrusted") else intAt(routing, "relayFanoutNormal")
	if (stored && hop < maxHop && allowMailboxRelayForTier(tier))
		relayed = deliverToUserRoomPeers(username, "mailbox_put", linkedMapOf("record" to record), null, relayFanout)

	return MailboxDeliverResult(stored = stored, delivered = delivered, relayed = relayed)
}

/**
 * @param username 副本用户名
 * @param toPubKeyHash 收件人
 * @param record 待发 record
 * @param toNodeHash 已知在线节点时直投
 * @return 存转结果
 */
@JvmOverloads
suspend fun publishMailboxRecord(
	username: String,
	toPubKeyHash: String,
	record: Map<String, Any?>,
	toNodeHash: String = "",
): MailboxDeliverResult {
	val scoped = LinkedHashMap(record)
	scoped["toPubKeyHash"] = toPubKeyHash
	return deliverOrStoreMailboxPut(
		username,
		linkedMapOf(
			"toPubKeyHash" to toPubKeyHash,
			"toNodeHash" to (if (jsTruthy(toNodeHash)) toNodeHash else JsonUndefined),
			"record" to scoped,
			"hop" to 0.0,
		),
	)
}

/**
 * @param wireContext 入站上下文
 * @param put 入站 mailbox_put
 * @param peerId Trystero 对端 id（有则校验 nodeHash 绑定）
 */
@JvmOverloads
suspend fun ingestMailboxPut(wireContext: WireContext, put: Map<String, Any?>, peerId: String = "") {
	val record = Json.obj(put["record"])
	if (record == null || !jsTruthy(record["envelope"]) || !jsTruthy(record["toPubKeyHash"])) return
	val fromNode = isHex64(put["nodeHash"]) ?: return
	if (!takeIncomingMailboxPutSlot(fromNode)) return
	val username = wireContext.replicaUsername ?: ""
	if (username.isEmpty()) return
	if (peerId.isNotEmpty()) {
		val remote = resolveRemoteNodeHashForPeer(peerId)
		if (remote == null || remote != fromNode) return
	}
	val routing = resolveRouting(username)
	val relayHop = resolveRelayHopForIngress(record)
	if (relayHop >= intAt(routing, "maxHop")) return
	val innerRecord = LinkedHashMap(record)
	innerRecord["fromNodeHash"] = fromNode
	deliverOrStoreMailboxPut(
		username,
		linkedMapOf(
			"toPubKeyHash" to record["toPubKeyHash"],
			"record" to innerRecord,
			"hop" to relayHop.toDouble(),
		),
	)
}

/**
 * 设计使然，不是漏洞：mailbox 是存转发（store-and-forward），want 与 put 对称。
 * @param want mailbox_want 载荷
 * @param sendGive mailbox_give 发送回调
 * @param peerId 请求方 peer
 */
suspend fun respondMailboxWant(
	want: Map<String, Any?>,
	sendGive: (payload: Any?, peerId: String) -> Unit,
	peerId: String,
) {
	val recipient = isHex64(want["toPubKeyHash"]) ?: return
	val ids = Json.arr(want["ids"]) ?: emptyList()
	val rows = (if (ids.isNotEmpty())
		getMailboxRecords(ids.map { jsString(it) })
	else
		takeMailboxForRecipient(recipient)
	).filter { it["toPubKeyHash"] == recipient && isDeliverableMailboxRecord(it) }
	if (rows.isEmpty()) return
	sendGive(linkedMapOf("toPubKeyHash" to recipient, "records" to rows.take(32)), peerId)
}

/**
 * @param wireContext 入站上下文
 * @param give mailbox_give 载荷
 * @return 投递给消费者的记录数
 */
suspend fun ingestMailboxGive(wireContext: WireContext, give: Map<String, Any?>): Int {
	val records = (Json.arr(give["records"]) ?: emptyList())
		.mapNotNull { it as? Map<String, Any?> }
		.filter { isDeliverableMailboxRecord(it) }
	if (records.isEmpty()) return 0
	val username = wireContext.replicaUsername ?: ""
	if (username.isEmpty()) return 0
	val delivered = dispatchMailboxRecordsToConsumers(username, records)
	if (delivered.isNotEmpty()) deleteMailboxRecords(delivered)
	return delivered.size
}

/**
 * @param username 副本用户名
 * @param toPubKeyHash 本机收件人 pubKeyHash
 */
suspend fun requestMailboxFromNetwork(username: String, toPubKeyHash: String) {
	val routing = resolveRouting(username)
	val recipient = toPubKeyHash
	if (recipient.isEmpty()) return
	deliverToUserRoomPeers(
		username,
		"mailbox_want",
		linkedMapOf(
			"toPubKeyHash" to recipient,
			"ids" to listMailboxIdsForRecipient(recipient).take(64),
		),
		null,
		intAt(routing, "wantFanout"),
	)
}

// 顶层引用：对象成员同名会遮蔽顶层函数，故先在此绑定。
private val ingestMailboxPutRef: suspend (WireContext, Map<String, Any?>, String) -> Unit = ::ingestMailboxPut
private val respondMailboxWantRef: suspend (Map<String, Any?>, (Any?, String) -> Unit, String) -> Unit = ::respondMailboxWant
private val ingestMailboxGiveRef: suspend (WireContext, Map<String, Any?>) -> Int = ::ingestMailboxGive

/**
 * 默认 mailbox 入站动作：经后台协程调用同名的存转实现（等价 JS `wire.mjs` 直接调用）。
 */
object DefaultMailboxWireHandlers : MailboxWireHandlers {
	override fun ingestMailboxPut(wireContext: WireContext, put: Map<String, Any?>, peerId: String) {
		mailboxDeliverScope.launch {
			try {
				ingestMailboxPutRef(wireContext, put, peerId)
			}
			catch (error: Throwable) {
				System.err.println("mailbox: put ingest failed $error")
			}
		}
	}

	override fun respondMailboxWant(
		want: Map<String, Any?>,
		sendGive: (payload: Any?, peerId: String) -> Unit,
		peerId: String,
	) {
		mailboxDeliverScope.launch {
			try {
				respondMailboxWantRef(want, sendGive, peerId)
			}
			catch (error: Throwable) {
				System.err.println("mailbox: want failed $error")
			}
		}
	}

	override fun ingestMailboxGive(wireContext: WireContext, give: Map<String, Any?>) {
		mailboxDeliverScope.launch {
			try {
				ingestMailboxGiveRef(wireContext, give)
			}
			catch (error: Throwable) {
				System.err.println("mailbox: give ingest failed $error")
			}
		}
	}
}
