package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.FEDERATION_CHUNK_MAX_BYTES
import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.files.chunk.fetchChunk
import io.github.steve02081504.fountp2p.files.chunk.createChunkReadStream
import io.github.steve02081504.fountp2p.files.chunk.getChunk
import io.github.steve02081504.fountp2p.files.chunk.hasChunk
import io.github.steve02081504.fountp2p.files.chunk.putChunk
import io.github.steve02081504.fountp2p.files.manifest.fetchManifest
import io.github.steve02081504.fountp2p.files.manifest.normalizeFileManifest
import io.github.steve02081504.fountp2p.files.manifest.publicTransferKeyDescriptor
import io.github.steve02081504.fountp2p.node.getEntityStore

/**
 * EVFS 文件读取 / 写入门面（等价 `files/evfs.mjs`）。
 */

/** manifest 拉取 miss 选项。 */
class ReadManifestOptions(
	/** 拉取身份（缺省用副本用户名） */
	val username: String? = null,
	/** chunk miss 拉取（缺省 [fetchChunk]） */
	val fetchChunk: (suspend (context: Map<String, Any?>) -> ByteArray?)? = null,
	/** chunk 定向目标集 */
	val fanoutTargets: List<Any?>? = null,
)

/** 公开文件读取选项。 */
class ReadPublicFileOptions(
	/** 拉取身份 */
	val username: String? = null,
	/** chunk miss 拉取 */
	val fetchChunk: (suspend (context: Map<String, Any?>) -> ByteArray?)? = null,
	/** 强制阻塞等待 fanout 择新 */
	val revalidate: Boolean = false,
	/** manifest 与 chunk 的定向目标集 */
	val fanoutTargets: List<Any?>? = null,
)

/**
 * @param replicaUsername 副本用户名
 * @param manifest 清单
 * @return 密钥依赖
 */
private fun transferKeyDependenciesForReplica(
	replicaUsername: String,
	manifest: Map<String, Any?>,
): ContentKeyDependencies {
	val raw = resolveTransferKeyDependencies(null, manifest)
	return ContentKeyDependencies(
		getGroupFileMasterKey = raw.getGroupFileMasterKey?.let { fn ->
			{ groupId, keyGeneration -> fn(replicaUsername, groupId, keyGeneration) }
		},
		getVaultMasterKey = raw.getVaultMasterKey?.let { fn ->
			{ entityHash -> fn(replicaUsername, entityHash) }
		},
	)
}

/**
 * @param username 拉取身份
 * @param manifest 清单
 * @param options miss 拉取
 * @return 全部 part 是否已就位
 */
private suspend fun ensureManifestPartsLocal(
	username: String,
	manifest: Map<String, Any?>,
	options: ReadManifestOptions,
): Boolean {
	@Suppress("UNCHECKED_CAST")
	val parts = manifest["parts"] as? List<Any?> ?: emptyList()
	val fetcher = options.fetchChunk ?: { context -> fetchChunk(context) }
	val descriptor = manifest["transferKeyDescriptor"] as? Map<*, *>
	for (rawPart in parts) {
		val part = rawPart as Map<*, *>
		val hash = part["hash"] as String
		if (hasChunk(hash)) continue
		val fetchedChunk = fetcher(
			linkedMapOf(
				"username" to username,
				"ciphertextHash" to hash,
				"ownerEntityHash" to manifest["ownerEntityHash"],
				"groupId" to descriptor?.get("groupId"),
				"fanoutTargets" to options.fanoutTargets,
			),
		)
		if (fetchedChunk == null) return false
		putChunk(hash, fetchedChunk)
	}
	return true
}

/**
 * @param ownerEntityHash 所有者
 * @param logicalPath 路径
 * @return 本机已写盘的 manifest
 */
suspend fun loadFileManifest(ownerEntityHash: String, logicalPath: String): Map<String, Any?>? {
	@Suppress("UNCHECKED_CAST")
	return getEntityStore().readManifest(ownerEntityHash, logicalPath) as? Map<String, Any?>
}

/**
 * @param manifest 清单
 */
suspend fun saveFileManifest(manifest: Map<String, Any?>) {
	val ownerEntityHash = manifest["ownerEntityHash"] as String
	val logicalPath = manifest["logicalPath"] as String
	getEntityStore().writeManifest(ownerEntityHash, logicalPath, manifest)
}

/**
 * 删除本机已写盘 manifest；其引用的 chunk 孤儿化后由 `cleanChunkGarbage` 回收。
 * @param ownerEntityHash 所有者
 * @param logicalPath 路径
 */
suspend fun deleteFileManifest(ownerEntityHash: String, logicalPath: String) {
	getEntityStore().deleteManifest(ownerEntityHash, logicalPath)
}

/**
 * @param manifest 清单
 * @param partBytes 密文块
 */
suspend fun storeManifestParts(manifest: Map<String, Any?>, partBytes: List<ByteArray>) {
	@Suppress("UNCHECKED_CAST")
	val parts = manifest["parts"] as? List<Any?> ?: emptyList()
	for (index in parts.indices) {
		val part = parts[index] as Map<*, *>
		putChunk(part["hash"] as String, partBytes[index])
	}
}

/**
 * @param replicaUsername 副本用户名
 * @param manifest 清单
 * @param options miss 拉取
 * @return 明文内容；失败为 null
 */
suspend fun readManifestPlaintext(
	replicaUsername: String,
	manifest: Map<String, Any?>,
	options: ReadManifestOptions = ReadManifestOptions(),
): ByteArray? {
	val meta = manifest["meta"] as? Map<*, *>
	val dagGroupId = meta?.get("groupId")
	val dagParts = meta?.get("dagParts") as? List<*>
	if (!dagParts.isNullOrEmpty() && jsTruthy(dagGroupId)) {
		val dagPlain = readDagManifestPlaintext(replicaUsername, manifest)
		if (dagPlain != null) return dagPlain
	}

	val username = options.username ?: replicaUsername
	if (!ensureManifestPartsLocal(username, manifest, options)) return null

	@Suppress("UNCHECKED_CAST")
	val parts = manifest["parts"] as? List<Any?> ?: emptyList()
	val partBytes = ArrayList<ByteArray>(parts.size)
	for (rawPart in parts) {
		val part = rawPart as Map<*, *>
		partBytes.add(getChunk(part["hash"] as String))
	}

	return assembleManifestPlaintext(manifest, partBytes, transferKeyDependenciesForReplica(replicaUsername, manifest))
}

/**
 * @param replicaUsername 副本用户名
 * @param manifest 清单
 * @param options miss 拉取
 * @return 明文数据源；失败为 null
 */
suspend fun readManifestPlaintextStream(
	replicaUsername: String,
	manifest: Map<String, Any?>,
	options: ReadManifestOptions = ReadManifestOptions(),
): ByteChunkSource? {
	val meta = manifest["meta"] as? Map<*, *>
	val dagGroupId = meta?.get("groupId")
	val dagParts = meta?.get("dagParts") as? List<*>
	if (!dagParts.isNullOrEmpty() && jsTruthy(dagGroupId)) {
		val plain = readManifestPlaintext(replicaUsername, manifest, options) ?: return null
		return chunkSourceOf(plain)
	}

	val username = options.username ?: replicaUsername
	if (!ensureManifestPartsLocal(username, manifest, options)) return null

	val dependencies = transferKeyDependenciesForReplica(replicaUsername, manifest)
	val contentKey = resolveContentKey(manifest["transferKeyDescriptor"], manifest, dependencies)
	if (manifest["ceMode"] == "random" && contentKey == null) return null

	@Suppress("UNCHECKED_CAST")
	val parts = manifest["parts"] as? List<Any?> ?: emptyList()
	val partStreams = parts.map { rawPart ->
		val part = rawPart as Map<*, *>
		createChunkReadStream(part["hash"] as String)
	}
	return createManifestPlaintextStream(manifest, partStreams, contentKey)
}

/**
 * @param parameters ownerEntityHash/logicalPath/plaintext/name/mimeType/ceMode/transferKeyDescriptor/meta
 * @return 写入后的 manifest
 */
suspend fun putFileManifest(parameters: Map<String, Any?>): Map<String, Any?> {
	val ownerEntityHash = parameters["ownerEntityHash"]
	val logicalPath = parameters["logicalPath"] as String
	@Suppress("UNCHECKED_CAST")
	val plaintextBuffer = parameters["plaintext"] as ByteArray
	val ceMode = parameters["ceMode"] as? String ?: "convergent"
	val enc = if (plaintextBuffer.size > FEDERATION_CHUNK_MAX_BYTES)
		encryptPlaintextToMultiPartsAsync(plaintextBuffer, ceMode)
	else encryptPlaintextToParts(plaintextBuffer, ceMode)
	val manifest = buildFileManifestFromEnc(
		linkedMapOf(
			"ownerEntityHash" to ownerEntityHash,
			"logicalPath" to logicalPath,
			"plaintext" to plaintextBuffer,
			"name" to parameters["name"],
			"mimeType" to parameters["mimeType"],
			"ceMode" to ceMode,
			"transferKeyDescriptor" to (parameters["transferKeyDescriptor"] ?: publicTransferKeyDescriptor()),
			"meta" to parameters["meta"],
		),
		enc,
	)
	storeManifestParts(manifest, enc.parts.map { it["raw"] as ByteArray })
	saveFileManifest(manifest)
	return manifest
}

/**
 * 流式写入文件（请求流 → 加密分块 → chunk store）。
 * @param parameters ownerEntityHash/logicalPath/readable/plainSize/name/mimeType/ceMode/transferKeyDescriptor/meta
 * @return 写入后的 manifest
 */
suspend fun putFileManifestFromStream(parameters: Map<String, Any?>): Map<String, Any?> {
	val ownerEntityHash = parameters["ownerEntityHash"]
	val logicalPath = parameters["logicalPath"] as String
	val readable = parameters["readable"] as ByteChunkSource
	val plainSize = parameters["plainSize"] as Double
	val ceMode = parameters["ceMode"] as? String ?: "convergent"
	val enc = encryptReadableToParts(
		readable,
		ceMode,
		{ part -> putChunk(part["hash"] as String, part["raw"] as ByteArray) },
		plainSize,
	)
	val name = parameters["name"] as? String
	val manifest = normalizeFileManifest(
		linkedMapOf(
			"ownerEntityHash" to ownerEntityHash,
			"logicalPath" to logicalPath.replace(Regex("^/+"), ""),
			"name" to (name ?: logicalPath.substringAfterLast('/').ifEmpty { "file" }),
			"mimeType" to (parameters["mimeType"] ?: "application/octet-stream"),
			"size" to plainSize,
			"contentHash" to enc.contentHash,
			"ceMode" to ceMode,
			"parts" to manifestPartsForPersist(enc.parts),
			"transferKeyDescriptor" to (parameters["transferKeyDescriptor"] ?: publicTransferKeyDescriptor()),
			"meta" to parameters["meta"],
		),
	)
	if (manifest == null) throw IllegalStateException("invalid manifest")
	saveFileManifest(manifest)
	return manifest
}

/**
 * 读取实体公开文件：本地 miss 时经网络取回签名 manifest，chunk miss 走既有 fetchChunk。
 * @param replicaUsername 副本用户名
 * @param entityHash owner entityHash
 * @param logicalPath EVFS 逻辑路径
 * @param options miss 拉取
 * @return 明文或 null
 */
suspend fun readPublicFile(
	replicaUsername: String,
	entityHash: String,
	logicalPath: String,
	options: ReadPublicFileOptions = ReadPublicFileOptions(),
): ByteArray? {
	val manifest = fetchManifest(
		linkedMapOf(
			"username" to (options.username ?: replicaUsername),
			"ownerEntityHash" to entityHash,
			"logicalPath" to logicalPath,
			"cache" to true,
			"revalidate" to options.revalidate,
			"fanoutTargets" to options.fanoutTargets,
		),
	) ?: return null
	return readManifestPlaintext(
		replicaUsername,
		manifest,
		ReadManifestOptions(
			username = options.username,
			fetchChunk = options.fetchChunk,
			fanoutTargets = options.fanoutTargets,
		),
	)
}
