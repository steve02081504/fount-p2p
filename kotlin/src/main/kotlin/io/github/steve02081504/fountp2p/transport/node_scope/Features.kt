package io.github.steve02081504.fountp2p.transport.node_scope

import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.files.fed.attachNodeScopeFedResponder
import io.github.steve02081504.fountp2p.mailbox.DefaultMailboxWireHandlers
import io.github.steve02081504.fountp2p.mailbox.attachMailboxWire
import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireContext
import io.github.steve02081504.fountp2p.wire.part.attachPartQueryWire
import io.github.steve02081504.fountp2p.wire.part.attachPartWire

/**
 * node scope feature 挂载（等价 `js/transport/node_scope/features.mjs`）。
 *
 * 同一 feature 重复 attach 共享一个 wire，dispose 引用计数归零才真正卸载。
 */

/** 首次 attach 时执行，返回卸载 dispose。 */
typealias NodeScopeFeatureAttach = (wire: WireAdapter, context: WireContext) -> () -> Unit

/** feature 卸载函数跟踪集。 */
private val nodeScopeFeatureDisposers = LinkedHashSet<() -> Unit>()

private class FeatureAttachRef(var count: Int, val disposeCore: () -> Unit)

/** key → 引用计数 attach 状态。 */
private val featureAttachRefs = LinkedHashMap<String, FeatureAttachRef>()

/**
 * @param dispose feature 卸载函数
 * @return 包装后的 dispose，同时从跟踪集移除。
 */
private fun trackFeatureDisposer(dispose: () -> Unit): () -> Unit {
	nodeScopeFeatureDisposers.add(dispose)
	return {
		dispose()
		nodeScopeFeatureDisposers.remove(dispose)
	}
}

/**
 * 同一 feature 重复 attach 共享一个 wire，dispose 引用计数归零才真正卸载。
 * @param key feature 去重键
 * @param attachCore 首次 attach 时执行，返回卸载 dispose
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
 * @param options 可选复制用户名
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
	"mailbox" to { wire, context -> attachMailboxWire(context, wire, DefaultMailboxWireHandlers) },
	"part" to { wire, context -> attachPartWire(context, wire) },
	"partQuery" to { wire, context -> attachPartQueryWire(context, wire) },
	"chunks" to { wire, _ -> attachNodeScopeFedResponder(wire) },
)

private fun attachBuiltin(key: String, options: Map<String, Any?> = emptyMap()): () -> Unit =
	attachNodeScopeFeature(key, builtinFeatures[key]!!, options)

/**
 * @param options 可选复制用户名
 * @return 取消挂载的 dispose
 */
fun attachNodeScopeMailbox(options: Map<String, Any?> = emptyMap()): () -> Unit = attachBuiltin("mailbox", options)

/**
 * @param options 可选复制用户名
 * @return 取消挂载的 dispose
 */
fun attachNodeScopePart(options: Map<String, Any?> = emptyMap()): () -> Unit = attachBuiltin("part", options)

/**
 * @param options 可选复制用户名
 * @return 取消挂载的 dispose
 */
fun attachNodeScopePartQuery(options: Map<String, Any?> = emptyMap()): () -> Unit = attachBuiltin("partQuery", options)

/**
 * @param options 可选复制用户名
 * @return 取消挂载的 dispose
 */
fun attachNodeScopeChunks(options: Map<String, Any?> = emptyMap()): () -> Unit = attachBuiltin("chunks", options)

/**
 * 全业务 preset（part / partQuery / mailbox / chunks）。
 * @param options 可选复制用户名
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
 * 卸载 feature 挂载，可选保留 node scope 核心。
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
