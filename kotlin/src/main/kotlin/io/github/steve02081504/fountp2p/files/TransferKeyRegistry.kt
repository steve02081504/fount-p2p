package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.files.manifest.resolveManifestOwner

/**
 * 传输密钥依赖注册表（等价 `files/transfer_key_registry.mjs`）。
 *
 * 按 manifest 族（ownerId）注册密钥源与 dagParts 明文读取器。
 */

/** 族级密钥源（首个参数为副本用户名）。 */
class TransferKeyDependenciesRaw(
	/** 群文件主密钥源 */
	val getGroupFileMasterKey: (suspend (replicaUsername: String, groupId: String, keyGeneration: Double?) -> ByteArray?)? = null,
	/** vault 主密钥源 */
	val getVaultMasterKey: (suspend (replicaUsername: String, entityHash: String) -> ByteArray?)? = null,
)

/** dagParts 明文读取器。 */
typealias DagManifestPlaintextReader = suspend (replicaUsername: String, manifest: Map<String, Any?>) -> ByteArray?

private val transferDependenciesByOwner = LinkedHashMap<String, TransferKeyDependenciesRaw>()

private val dagPlaintextReadersByOwner = LinkedHashMap<String, DagManifestPlaintextReader>()

/**
 * @param ownerId 注册方（族，须与 registerManifestOwner 一致）
 * @param dependencies 密钥源
 */
fun registerTransferKeyDependencies(ownerId: String, dependencies: TransferKeyDependenciesRaw) {
	val previous = transferDependenciesByOwner[ownerId]
	transferDependenciesByOwner[ownerId] = TransferKeyDependenciesRaw(
		getGroupFileMasterKey = dependencies.getGroupFileMasterKey ?: previous?.getGroupFileMasterKey,
		getVaultMasterKey = dependencies.getVaultMasterKey ?: previous?.getVaultMasterKey,
	)
}

/**
 * @param ownerId 注册方
 * @param reader dagParts 明文读取
 */
fun registerDagManifestPlaintextReader(ownerId: String, reader: DagManifestPlaintextReader) {
	dagPlaintextReadersByOwner[ownerId] = reader
}

/** @param ownerId 注册方 */
fun unregisterTransferKeyDependencies(ownerId: String) {
	transferDependenciesByOwner.remove(ownerId)
	dagPlaintextReadersByOwner.remove(ownerId)
}

/**
 * @param ownerId 显式注册方；省略时按 manifest 推断
 * @param manifest 用于推断 ownerId
 * @return 依赖
 */
fun resolveTransferKeyDependencies(ownerId: String?, manifest: Map<String, Any?>? = null): TransferKeyDependenciesRaw {
	val resolved = ownerId ?: manifest?.let { resolveManifestOwner(it, it["ownerEntityHash"] as? String ?: "") }
	if (resolved != null) return transferDependenciesByOwner[resolved] ?: TransferKeyDependenciesRaw()
	return TransferKeyDependenciesRaw()
}

/**
 * @param replicaUsername 副本用户名
 * @param manifest 清单
 * @return 明文；无 reader 或未命中为 null
 */
suspend fun readDagManifestPlaintext(replicaUsername: String, manifest: Map<String, Any?>): ByteArray? {
	val ownerId = resolveManifestOwner(manifest, manifest["ownerEntityHash"] as? String ?: "")
	if (ownerId != null) {
		val reader = dagPlaintextReadersByOwner[ownerId]
		if (reader != null)
			try {
				val buffer = reader(replicaUsername, manifest)
				if (buffer != null && buffer.isNotEmpty()) return buffer
			}
			catch (_: Throwable) {
				// 读取失败则回落到分块路径
			}
	}
	return null
}
