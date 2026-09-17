package io.github.steve02081504.fountp2p.transport.node_scope

import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.files.fed.attachNodeScopeFedResponder
import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireContext

/**
 * node scope feature 挂载（等价 `js/transport/node_scope/features.mjs`）。
 *
 * 偏离：JS `builtinFeatures` 直接 import `mailbox/wire`、`wire/part/ingress`、
 * `wire/part/query` 与 `files/fed/responder`。Kotlin 侧 `wire/part` 下模块尚未移植，
 * 且已移植的 `attachMailboxWire` 需要注入 `MailboxWireHandlers`，因此这里把
 * mailbox / part / partQuery 的 attacher 做成可注入接口（默认抛
 * `UnsupportedOperationException`，符合本仓库「平台抽象约定」）；chunks 直接复用
 * 已移植的 [attachNodeScopeFedResponder]。引用计数与 dispose 语义完全一致。
 */

/** 首次 attach 时执行，返回核心 dispose。 */
typealias NodeScopeFeatureAttach = (wire: WireAdapter, context: WireContext) -> () -> Unit

/**
 * 未移植 / 需业务注入的 builtin attacher。
 */
object NodeScopeFeatureAttachers {
	/** mailbox feature attacher（需 `MailboxWireHandlers`）。 */
	var mailbox: NodeScopeFeatureAttach? = null

	/** part feature attacher（`wire/part/ingress` 未移植）。 */
	var part: NodeScopeFeatureAttach? = null

	/** partQuery feature attacher（`wire/part/query` 未移植）。 */
	var partQuery: NodeScopeFeatureAttach? = null
}

private fun missingAttacher(name: String): NodeScopeFeatureAttach =
	{ _, _ -> throw UnsupportedOperationException("node scope feature '$name' requires an injected attacher") }

/** feature 卸载函数跟踪集。 */
private val nodeScopeFeatureDisposers = LinkedHashSet<() -> Unit>()

private class FeatureAttachRef(var count: Int, val disposeCore: () -> Unit)

/** key → 引用计数 attach 状态。 */
private val featureAttachRefs = LinkedHashMap<String, FeatureAttachRef>()

/**
 * @param dispose feature 卸载函数
 * @return 包装后的 dispose（同时从跟踪集移除）
 */
private fun trackFeatureDisposer(dispose: () -> Unit): () -> Unit {
	nodeScopeFeatureDisposers.add(dispose)
	return {
		dispose()
		nodeScopeFeatureDisposers.remove(dispose)
	}
}

/**
 * 同一 feature 多次 attach 共享一份 wire；dispose 引用计数归零才卸。
 * @param key feature 去重键
 * @param attachCore 首次 attach 时执行，返回核心 dispose
 * @return 引用计数包装的 dispose
 */
private fun attachFeatureRefCounted(key: String, attachCore: () -> () -> Unit): () -> Unit {
	var entry = featureAttachRefs[key]
	if (entry == null) {
		entry = FeatureAttachRef(0, attachCore())
		featureAttachRefs[key] = entry
	}
	entry.count++
	return trackFeatureDisposer {
		val current = featureAttachRefs[key]
		if (current == null) return@trackFeatureDisposer
		current.count--
		if (current.count > 0) return@trackFeatureDisposer
		current.disposeCore()
		featureAttachRefs.remove(key)
	}
}

/**
 * @param key feature 去重键
 * @param attachCore 首次 attach
 * @param options 可选副本用户名
 * @return 引用计数包装的 dispose
 */
fun attachNodeScopeFeature(
	key: String,
	attachCore: NodeScopeFeatureAttach,
	options: Map<String, Any?> = emptyMap(),
): () -> Unit {
	ensureNodeScope(options)
	return attachFeatureRefCounted(key) { attachCore(getNodeScopeWire()!!, getNodeScopeContext()) }
}

private val builtinFeatures: Map<String, NodeScopeFeatureAttach> = linkedMapOf(
	"mailbox" to { wire, context -> (NodeScopeFeatureAttachers.mailbox ?: missingAttacher("mailbox"))(wire, context) },
	"part" to { wire, context -> (NodeScopeFeatureAttachers.part ?: missingAttacher("part"))(wire, context) },
	"partQuery" to { wire, context -> (NodeScopeFeatureAttachers.partQuery ?: missingAttacher("partQuery"))(wire, context) },
	"chunks" to { wire, _ -> attachNodeScopeFedResponder(wire) },
)

private fun attachBuiltin(key: String, options: Map<String, Any?> = emptyMap()): () -> Unit =
	attachNodeScopeFeature(key, builtinFeatures[key]!!, options)

/**
 * @param options 可选副本用户名
 * @return 取消挂载的 dispose
 */
fun attachNodeScopeMailbox(options: Map<String, Any?> = emptyMap()): () -> Unit = attachBuiltin("mailbox", options)

/**
 * @param options 可选副本用户名
 * @return 取消挂载的 dispose
 */
fun attachNodeScopePart(options: Map<String, Any?> = emptyMap()): () -> Unit = attachBuiltin("part", options)

/**
 * @param options 可选副本用户名
 * @return 取消挂载的 dispose
 */
fun attachNodeScopePartQuery(options: Map<String, Any?> = emptyMap()): () -> Unit = attachBuiltin("partQuery", options)

/**
 * @param options 可选副本用户名
 * @return 取消挂载的 dispose
 */
fun attachNodeScopeChunks(options: Map<String, Any?> = emptyMap()): () -> Unit = attachBuiltin("chunks", options)

/**
 * 全业务 preset（part / partQuery / mailbox / chunks）。
 * @param options 可选副本用户名
 * @return 取消全部 preset 挂载的 dispose
 */
fun attachNodeScopeDefaultFeatures(options: Map<String, Any?> = emptyMap()): () -> Unit {
	val disposers = listOf(
		attachNodeScopePart(options),
		attachNodeScopePartQuery(options),
		attachNodeScopeMailbox(options),
		attachNodeScopeChunks(options),
	)
	return { for (dispose in disposers) dispose() }
}

/**
 * 卸掉 feature 挂载；可选保留 node scope 订阅。
 * @param options `keepSubscribe = true` 时保留 node scope 订阅
 */
fun stopNodeScopeRuntime(options: Map<String, Any?> = emptyMap()) {
	for (dispose in nodeScopeFeatureDisposers.toList()) dispose()
	nodeScopeFeatureDisposers.clear()
	for (entry in featureAttachRefs.values) {
		try {
			entry.disposeCore()
		}
		catch (_: Throwable) {
			// ignore
		}
	}
	featureAttachRefs.clear()
	if (jsTruthy(options["keepSubscribe"])) return
	clearNodeScopeSubscribe()
}
