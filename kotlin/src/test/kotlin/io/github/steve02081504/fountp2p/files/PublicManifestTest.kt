package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.entityHashFromRecoveryPubKeyHex
import io.github.steve02081504.fountp2p.core.logicalEntityHash
import io.github.steve02081504.fountp2p.files.manifest.ManifestServicerContext
import io.github.steve02081504.fountp2p.files.manifest.cachePublicManifest
import io.github.steve02081504.fountp2p.files.manifest.fetchManifest
import io.github.steve02081504.fountp2p.files.manifest.handleIncomingManifestGet
import io.github.steve02081504.fountp2p.files.manifest.pendingManifestFetches
import io.github.steve02081504.fountp2p.files.manifest.publicTransferKeyDescriptor
import io.github.steve02081504.fountp2p.files.manifest.manifestFetchExpectedKey
import io.github.steve02081504.fountp2p.files.manifest.registerManifestFetchWait
import io.github.steve02081504.fountp2p.files.manifest.registerManifestOwner
import io.github.steve02081504.fountp2p.files.manifest.registerManifestServicer
import io.github.steve02081504.fountp2p.files.manifest.resolvePendingManifestFetch
import io.github.steve02081504.fountp2p.files.manifest.shouldPreferIncomingPublicManifest
import io.github.steve02081504.fountp2p.files.manifest.unregisterManifestOwner
import io.github.steve02081504.fountp2p.files.manifest.unregisterManifestServicer
import io.github.steve02081504.fountp2p.files.manifest.verifySignedPublicManifest
import io.github.steve02081504.fountp2p.files.manifest.attachPublicManifestSig
import io.github.steve02081504.fountp2p.files.manifest.publishPublicFile
import io.github.steve02081504.fountp2p.node.getEntityStore
import io.github.steve02081504.fountp2p.node.withTempNode
import io.github.steve02081504.fountp2p.utils.ms
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `js/test/pure/public_manifest.test.mjs`。 */
class PublicManifestTest {
	private fun publishedAtOf(manifest: Any?): Double? {
		val meta = Json.at(manifest, "meta") as? Map<*, *> ?: return null
		val signature = meta["publicSig"] as? Map<*, *> ?: return null
		return (signature["publishedAt"] as? Number)?.toDouble()
	}

	private fun buildSignedManifest(
		ownerEntityHash: String,
		logicalPath: String,
		plain: String,
		keys: TestRecoveryKeys,
		publishedAt: Double,
	): Map<String, Any?> {
		val plaintext = plain.toByteArray(Charsets.UTF_8)
		val enc = encryptPlaintextToParts(plaintext, "convergent")
		val base = buildFileManifestFromEnc(
			mapOf(
				"ownerEntityHash" to ownerEntityHash,
				"logicalPath" to logicalPath,
				"plaintext" to plaintext,
				"name" to "x",
				"mimeType" to "text/plain",
				"ceMode" to "convergent",
				"transferKeyDescriptor" to publicTransferKeyDescriptor(),
			),
			enc,
		)
		return attachPublicManifestSig(base, publishedAt, keys.secretKey, keys.pubKeyHex)
	}

	private fun buildNonPublicManifest(
		ownerEntityHash: String,
		logicalPath: String,
		plain: String,
		type: String,
	): Map<String, Any?> {
		val plaintext = plain.toByteArray(Charsets.UTF_8)
		return buildFileManifestFromEnc(
			mapOf(
				"ownerEntityHash" to ownerEntityHash,
				"logicalPath" to logicalPath,
				"plaintext" to plaintext,
				"name" to "x",
				"mimeType" to "text/plain",
				"ceMode" to "convergent",
				"transferKeyDescriptor" to mapOf("type" to type, "entityHash" to ownerEntityHash),
				"meta" to mapOf("dagParts" to listOf(mapOf("hash" to "a".repeat(64))), "groupId" to "g1"),
			),
			encryptPlaintextToParts(plaintext, "convergent"),
		)
	}

	private fun copyWithMeta(signed: Map<String, Any?>, mutate: (LinkedHashMap<String, Any?>) -> Unit): LinkedHashMap<String, Any?> {
		val copy = LinkedHashMap(signed)
		val meta = LinkedHashMap(Json.at(signed, "meta") as Map<String, Any?>)
		mutate(meta)
		copy["meta"] = meta
		return copy
	}

	private suspend fun waitForPendingManifestRequestId(timeoutMs: Long = ms("2s")): String? {
		val deadline = System.currentTimeMillis() + timeoutMs
		while (System.currentTimeMillis() < deadline) {
			val requestId = pendingManifestFetches.keys.firstOrNull()
			if (requestId != null) return requestId
			delay(5)
		}
		return null
	}

	@Test
	fun `public manifest sign verify roundtrip`() {
		val keys = testRecoveryKeys(1)
		val nodeHash = "a".repeat(64)
		val owner = entityHashFromRecoveryPubKeyHex(nodeHash, keys.pubKeyHex)
		val signed = buildSignedManifest(owner, "profile.json", "hello", keys, 1_700_000_000_000.0)
		val verified = verifySignedPublicManifest(signed)
		assertEquals(owner, verified?.get("ownerEntityHash"))
		assertEquals("profile.json", verified?.get("logicalPath"))
		assertEquals(1_700_000_000_000.0, publishedAtOf(verified))
	}

	@Test
	fun `public manifest rejects tampered parts`() {
		val keys = testRecoveryKeys(2)
		val owner = entityHashFromRecoveryPubKeyHex("b".repeat(64), keys.pubKeyHex)
		val signed = buildSignedManifest(owner, "profile/avatar", "img", keys, 100.0)
		val parts = ArrayList(signed["parts"] as List<Any?>)
		val tamperedPart = LinkedHashMap(parts[0] as Map<String, Any?>)
		tamperedPart["hash"] = "c".repeat(64)
		parts[0] = tamperedPart
		val tampered = LinkedHashMap(signed)
		tampered["parts"] = parts
		assertNull(verifySignedPublicManifest(tampered))
	}

	@Test
	fun `public manifest rejects wrong owner path non-public`() {
		val keys = testRecoveryKeys(3)
		val owner = entityHashFromRecoveryPubKeyHex("d".repeat(64), keys.pubKeyHex)
		val signed = buildSignedManifest(owner, "a", "x", keys, 200.0)

		val wrongOwner = LinkedHashMap(signed)
		wrongOwner["ownerEntityHash"] = entityHashFromRecoveryPubKeyHex("e".repeat(64), keys.pubKeyHex)
		assertNull(verifySignedPublicManifest(wrongOwner))

		val wrongPath = LinkedHashMap(signed)
		wrongPath["logicalPath"] = "b"
		assertNull(verifySignedPublicManifest(wrongPath))

		val privateMk = LinkedHashMap(signed)
		privateMk["transferKeyDescriptor"] = mapOf("type" to "vault-wrap", "entityHash" to owner)
		assertNull(verifySignedPublicManifest(privateMk))
	}

	@Test
	fun `public manifest rejects wrong recovery key for entityHash`() {
		val keysA = testRecoveryKeys(4)
		val keysB = testRecoveryKeys(5)
		val owner = entityHashFromRecoveryPubKeyHex("f".repeat(64), keysA.pubKeyHex)
		val signed = buildSignedManifest(owner, "p", "x", keysB, 300.0)
		assertNull(verifySignedPublicManifest(signed))
	}

	@Test
	fun `verify strips unsigned meta extensions from incoming manifest`() {
		val keys = testRecoveryKeys(9)
		val owner = entityHashFromRecoveryPubKeyHex("9".repeat(64), keys.pubKeyHex)
		val signed = buildSignedManifest(owner, "p", "x", keys, 700.0)
		val poisoned = copyWithMeta(signed) { meta ->
			meta["groupId"] = "evil-group"
			meta["dagParts"] = listOf(mapOf("hash" to "a".repeat(64)))
		}
		val verified = verifySignedPublicManifest(poisoned)!!
		val meta = verified["meta"] as Map<*, *>
		assertEquals(listOf("publicSig"), meta.keys.toList())
		assertEquals(700.0, publishedAtOf(verified))
	}

	@Test
	fun `shouldPreferIncomingPublicManifest by publishedAt`() {
		val older = mapOf("meta" to mapOf("publicSig" to mapOf("publishedAt" to 10.0)))
		val newer = mapOf("meta" to mapOf("publicSig" to mapOf("publishedAt" to 20.0)))
		assertEquals(true, shouldPreferIncomingPublicManifest(older, newer))
		assertEquals(false, shouldPreferIncomingPublicManifest(newer, older))
		assertEquals(true, shouldPreferIncomingPublicManifest(null, newer))
		assertEquals(false, shouldPreferIncomingPublicManifest(older, mapOf("meta" to emptyMap<String, Any?>())))
	}

	@Test
	fun `fake manifest data does not resolve pending wait`() = runBlocking {
		settleAllPendingManifestFetches()
		val keys = testRecoveryKeys(6)
		val owner = entityHashFromRecoveryPubKeyHex("1".repeat(64), keys.pubKeyHex)
		val signed = buildSignedManifest(owner, "profile.json", "ok", keys, 400.0)
		val bad = copyWithMeta(signed) { meta ->
			@Suppress("UNCHECKED_CAST")
			val publicSig = LinkedHashMap(meta["publicSig"] as Map<String, Any?>)
			publicSig["sigHex"] = "a".repeat(128)
			meta["publicSig"] = publicSig
		}

		val requestId = "pending-manifest-fake-1"
		val handle = registerManifestFetchWait(
			requestId,
			manifestFetchExpectedKey(owner, "profile.json"),
			200,
		)
		assertEquals(false, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to bad)))
		assertEquals(
			false,
			resolvePendingManifestFetch(
				mapOf("requestId" to requestId, "manifest" to (LinkedHashMap(signed).apply { this["logicalPath"] = "other.json" })),
			),
		)
		assertNull(handle.done.await())
	}

	@Test
	fun `valid manifest data resolves pending wait`() = runBlocking {
		settleAllPendingManifestFetches()
		val keys = testRecoveryKeys(7)
		val owner = entityHashFromRecoveryPubKeyHex("2".repeat(64), keys.pubKeyHex)
		val signed = buildSignedManifest(owner, "profile.json", "ok", keys, 500.0)
		val requestId = "pending-manifest-ok-1"
		val handle = registerManifestFetchWait(
			requestId,
			manifestFetchExpectedKey(owner, "profile.json"),
			ms("2s"),
		)
		assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to signed)))
		val got = handle.done.await()
		assertEquals("profile.json", got?.get("logicalPath"))
		assertEquals(500.0, publishedAtOf(got))
	}

	@Test
	fun `publishPublicFile writes verifiable public manifest`() = runBlocking {
		withTempNode("fount-pub-manifest-") {
			val keys = testRecoveryKeys(8)
			val owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), keys.pubKeyHex)
			val published = publishPublicFile(
				mapOf(
					"ownerEntityHash" to owner,
					"logicalPath" to "profile.json",
					"plaintext" to "{\"name\":\"t\"}".toByteArray(Charsets.UTF_8),
					"name" to "profile.json",
					"mimeType" to "application/json",
					"entitySecretKey" to keys.secretKey,
					"entityPubKeyHex" to keys.pubKeyHex,
					"publishedAt" to 600.0,
				),
			)
			val verified = verifySignedPublicManifest(published)
			assertEquals(600.0, publishedAtOf(verified))
			@Suppress("UNCHECKED_CAST")
			val descriptor = verified?.get("transferKeyDescriptor") as? Map<*, *>
			assertEquals("public", descriptor?.get("type"))
		}
	}

	@Test
	fun `fed_manifest_get refuses non-public manifest without registered servicer`() = runBlocking {
		withTempNode("fount-fed-manifest-priv-") {
			val owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(10).pubKeyHex)
			val plaintext = "secret".toByteArray(Charsets.UTF_8)
			getEntityStore().writeManifest(
				owner,
				"vault/secret.bin",
				buildFileManifestFromEnc(
					mapOf(
						"ownerEntityHash" to owner,
						"logicalPath" to "vault/secret.bin",
						"plaintext" to plaintext,
						"name" to "secret.bin",
						"mimeType" to "application/octet-stream",
						"ceMode" to "convergent",
						"transferKeyDescriptor" to mapOf("type" to "vault-wrap", "entityHash" to owner),
					),
					encryptPlaintextToParts(plaintext, "convergent"),
				),
			)
			var called = false
			handleIncomingManifestGet(
				mapOf("requestId" to "r1", "ownerEntityHash" to owner, "logicalPath" to "vault/secret.bin"),
				{ _, _ -> called = true },
				"a".repeat(64),
			)
			assertEquals(false, called)
		}
	}

	@Test
	fun `fed_manifest_get serves non-public manifest when servicer allows`() = runBlocking {
		withTempNode("fount-fed-manifest-servicer-") {
			val owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(18).pubKeyHex)
			val plaintext = "secret".toByteArray(Charsets.UTF_8)
			getEntityStore().writeManifest(
				owner,
				"vault/secret.bin",
				buildFileManifestFromEnc(
					mapOf(
						"ownerEntityHash" to owner,
						"logicalPath" to "vault/secret.bin",
						"plaintext" to plaintext,
						"name" to "secret.bin",
						"mimeType" to "application/octet-stream",
						"ceMode" to "convergent",
						"transferKeyDescriptor" to mapOf("type" to "vault-wrap", "entityHash" to owner),
						"meta" to mapOf("dagParts" to listOf(mapOf("hash" to "a".repeat(64))), "groupId" to "g1"),
					),
					encryptPlaintextToParts(plaintext, "convergent"),
				),
			)

			var seen: ManifestServicerContext? = null
			registerManifestOwner("test") { _, ownerEntityHash -> ownerEntityHash == owner }
			registerManifestServicer("test") { context ->
				seen = context
				true
			}
			try {
				var response: Map<String, Any?>? = null
				handleIncomingManifestGet(
					mapOf("requestId" to "r2", "ownerEntityHash" to owner, "logicalPath" to "vault/secret.bin"),
					{ payload, _ -> response = payload },
					"b".repeat(64),
				)
				assertEquals("r2", response?.get("requestId"))
				@Suppress("UNCHECKED_CAST")
				val manifest = response?.get("manifest") as Map<String, Any?>
				@Suppress("UNCHECKED_CAST")
				val descriptor = manifest["transferKeyDescriptor"] as Map<String, Any?>
				assertEquals("vault-wrap", descriptor["type"])
				@Suppress("UNCHECKED_CAST")
				val meta = manifest["meta"] as Map<String, Any?>
				assertEquals("g1", meta["groupId"])
				@Suppress("UNCHECKED_CAST")
				assertEquals(1, (meta["dagParts"] as List<Any?>).size)
				assertEquals("b".repeat(64), seen?.requesterNodeHash)
				assertEquals("b".repeat(64), seen?.peerId)
				assertEquals("vault/secret.bin", seen?.logicalPath)
			}
			finally {
				unregisterManifestServicer("test")
				unregisterManifestOwner("test")
			}
		}
	}

	@Test
	fun `fed_manifest_get refuses non-public manifest when servicer denies`() = runBlocking {
		withTempNode("fount-fed-manifest-deny-") {
			val owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(19).pubKeyHex)
			val plaintext = "secret".toByteArray(Charsets.UTF_8)
			getEntityStore().writeManifest(
				owner,
				"vault/secret.bin",
				buildFileManifestFromEnc(
					mapOf(
						"ownerEntityHash" to owner,
						"logicalPath" to "vault/secret.bin",
						"plaintext" to plaintext,
						"name" to "secret.bin",
						"mimeType" to "application/octet-stream",
						"ceMode" to "convergent",
						"transferKeyDescriptor" to mapOf("type" to "vault-wrap", "entityHash" to owner),
					),
					encryptPlaintextToParts(plaintext, "convergent"),
				),
			)
			registerManifestOwner("test") { _, ownerEntityHash -> ownerEntityHash == owner }
			registerManifestServicer("test") { false }
			try {
				var called = false
				handleIncomingManifestGet(
					mapOf("requestId" to "r3", "ownerEntityHash" to owner, "logicalPath" to "vault/secret.bin"),
					{ _, _ -> called = true },
					"c".repeat(64),
				)
				assertEquals(false, called)
			}
			finally {
				unregisterManifestServicer("test")
				unregisterManifestOwner("test")
			}
		}
	}

	@Test
	fun `fed_manifest_get refuses public manifest without publicSig`() = runBlocking {
		withTempNode("fount-fed-manifest-nosig-") {
			val owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(11).pubKeyHex)
			val plaintext = "x".toByteArray(Charsets.UTF_8)
			getEntityStore().writeManifest(
				owner,
				"profile.json",
				buildFileManifestFromEnc(
					mapOf(
						"ownerEntityHash" to owner,
						"logicalPath" to "profile.json",
						"plaintext" to plaintext,
						"name" to "profile.json",
						"mimeType" to "application/json",
						"ceMode" to "convergent",
						"transferKeyDescriptor" to publicTransferKeyDescriptor(),
					),
					encryptPlaintextToParts(plaintext, "convergent"),
				),
			)
			var called = false
			handleIncomingManifestGet(
				mapOf("requestId" to "r2", "ownerEntityHash" to owner, "logicalPath" to "profile.json"),
				{ _, _ -> called = true },
				"peer",
			)
			assertEquals(false, called)
		}
	}

	@Test
	fun `fed_manifest_get responds with publicSig-only meta`() = runBlocking {
		withTempNode("fount-fed-manifest-ok-") {
			val keys = testRecoveryKeys(12)
			val owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), keys.pubKeyHex)
			val published = publishPublicFile(
				mapOf(
					"ownerEntityHash" to owner,
					"logicalPath" to "profile.json",
					"plaintext" to "{}".toByteArray(Charsets.UTF_8),
					"name" to "profile.json",
					"mimeType" to "application/json",
					"entitySecretKey" to keys.secretKey,
					"entityPubKeyHex" to keys.pubKeyHex,
					"publishedAt" to 800.0,
				),
			)
			// 本地扩展不应外泄
			val extended = copyWithMeta(published) { meta ->
				meta["groupId"] = "local-only"
				meta["dagParts"] = listOf(mapOf("hash" to "a".repeat(64)))
			}
			getEntityStore().writeManifest(owner, "profile.json", extended)
			var response: Map<String, Any?>? = null
			handleIncomingManifestGet(
				mapOf("requestId" to "r3", "ownerEntityHash" to owner, "logicalPath" to "profile.json"),
				{ payload, _ -> response = payload },
				"peer",
			)
			assertEquals("r3", response?.get("requestId"))
			@Suppress("UNCHECKED_CAST")
			val manifest = response?.get("manifest") as Map<String, Any?>
			@Suppress("UNCHECKED_CAST")
			val meta = manifest["meta"] as Map<String, Any?>
			assertEquals(listOf("publicSig"), meta.keys.toList())
			assertEquals(800.0, publishedAtOf(manifest))
			@Suppress("UNCHECKED_CAST")
			val descriptor = manifest["transferKeyDescriptor"] as Map<String, Any?>
			assertEquals("public", descriptor["type"])
		}
	}

	@Test
	fun `fetchManifest returns local publicSig immediately without awaiting fanout`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-swr-fast-") {
			val keys = testRecoveryKeys(13)
			val owner = entityHashFromRecoveryPubKeyHex("a".repeat(64), keys.pubKeyHex)
			val local = buildSignedManifest(owner, "profile.json", "cached", keys, 1500.0)
			cachePublicManifest(owner, "profile.json", local)

			val started = System.currentTimeMillis()
			val result = fetchManifest(
				mapOf(
					"username" to "u",
					"ownerEntityHash" to owner,
					"logicalPath" to "profile.json",
					"timeoutMs" to ms("8s"),
				),
			)
			assertEquals(1500.0, publishedAtOf(result))
			assertEquals(true, System.currentTimeMillis() - started < 500)
			// fanout 仍在飞，供后台刷新
			assertEquals(true, waitForPendingManifestRequestId() != null)
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest revalidates local publicSig in background and caches newer publishedAt`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-revalidate-") {
			val keys = testRecoveryKeys(14)
			val owner = entityHashFromRecoveryPubKeyHex("b".repeat(64), keys.pubKeyHex)
			val older = buildSignedManifest(owner, "profile.json", "v1", keys, 1000.0)
			val newer = buildSignedManifest(owner, "profile.json", "v2", keys, 2000.0)
			cachePublicManifest(owner, "profile.json", older)

			assertEquals(
				1000.0,
				publishedAtOf(
					fetchManifest(
						mapOf(
							"username" to "u",
							"ownerEntityHash" to owner,
							"logicalPath" to "profile.json",
							"cache" to true,
						),
					),
				),
			)

			val requestId = waitForPendingManifestRequestId()
			assertEquals(true, requestId != null)
			assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to newer)))

			val deadline = System.currentTimeMillis() + ms("2s")
			var cachedAt: Double? = 1000.0
			while (System.currentTimeMillis() < deadline) {
				cachedAt = publishedAtOf(loadFileManifest(owner, "profile.json"))
				if (cachedAt == 2000.0) break
				delay(5)
			}
			assertEquals(2000.0, cachedAt)
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest keeps local when incoming publishedAt is not newer`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-keep-local-") {
			val keys = testRecoveryKeys(15)
			val owner = entityHashFromRecoveryPubKeyHex("c".repeat(64), keys.pubKeyHex)
			val newer = buildSignedManifest(owner, "profile.json", "v2", keys, 2000.0)
			val older = buildSignedManifest(owner, "profile.json", "v1", keys, 1000.0)
			cachePublicManifest(owner, "profile.json", newer)

			assertEquals(
				2000.0,
				publishedAtOf(
					fetchManifest(
						mapOf(
							"username" to "u",
							"ownerEntityHash" to owner,
							"logicalPath" to "profile.json",
							"cache" to true,
						),
					),
				),
			)

			val requestId = waitForPendingManifestRequestId()
			assertEquals(true, requestId != null)
			assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to older)))
			delay(30)
			assertEquals(2000.0, publishedAtOf(loadFileManifest(owner, "profile.json")))
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest revalidate true blocks and returns newer manifest from fanout`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-revalidate-block-") {
			val keys = testRecoveryKeys(31)
			val owner = entityHashFromRecoveryPubKeyHex("f0".repeat(32), keys.pubKeyHex)
			val older = buildSignedManifest(owner, "profile.json", "v1", keys, 1000.0)
			val newer = buildSignedManifest(owner, "profile.json", "v2", keys, 2000.0)
			cachePublicManifest(owner, "profile.json", older)

			coroutineScope {
				val fetchDeferred = async {
					fetchManifest(
						mapOf(
							"username" to "u",
							"ownerEntityHash" to owner,
							"logicalPath" to "profile.json",
							"cache" to true,
							"revalidate" to true,
						),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				// 阻塞等待 fanout：结算前不得返回本地旧清单
				assertEquals(false, fetchDeferred.isCompleted)
				assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to newer)))
				assertEquals(2000.0, publishedAtOf(fetchDeferred.await()))
			}
			// 择新已写回本地缓存
			assertEquals(2000.0, publishedAtOf(loadFileManifest(owner, "profile.json")))
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest revalidate true keeps local when fanout yields nothing newer`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-revalidate-older-") {
			val keys = testRecoveryKeys(32)
			val owner = entityHashFromRecoveryPubKeyHex("f1".repeat(32), keys.pubKeyHex)
			val newer = buildSignedManifest(owner, "profile.json", "v2", keys, 2000.0)
			val older = buildSignedManifest(owner, "profile.json", "v1", keys, 1000.0)
			cachePublicManifest(owner, "profile.json", newer)

			coroutineScope {
				val fetchDeferred = async {
					fetchManifest(
						mapOf(
							"username" to "u",
							"ownerEntityHash" to owner,
							"logicalPath" to "profile.json",
							"cache" to true,
							"revalidate" to true,
						),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to older)))
				assertEquals(2000.0, publishedAtOf(fetchDeferred.await()))
			}
			assertEquals(2000.0, publishedAtOf(loadFileManifest(owner, "profile.json")))
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest revalidate true falls back to local when fanout times out`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-revalidate-timeout-") {
			val keys = testRecoveryKeys(33)
			val owner = entityHashFromRecoveryPubKeyHex("f2".repeat(32), keys.pubKeyHex)
			val local = buildSignedManifest(owner, "profile.json", "cached", keys, 1000.0)
			cachePublicManifest(owner, "profile.json", local)

			val started = System.currentTimeMillis()
			val result = fetchManifest(
				mapOf(
					"username" to "u",
					"ownerEntityHash" to owner,
					"logicalPath" to "profile.json",
					"cache" to true,
					"revalidate" to true,
					"timeoutMs" to 200,
				),
			)
			assertEquals(1000.0, publishedAtOf(result))
			// 确曾阻塞等待 fanout 超时（而非立即返回本地）
			assertEquals(true, System.currentTimeMillis() - started >= 150)
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `readPublicFile revalidate true returns republished plaintext on one read`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-read-pub-revalidate-") {
			val keys = testRecoveryKeys(34)
			val owner = entityHashFromRecoveryPubKeyHex("f3".repeat(32), keys.pubKeyHex)
			val older = buildSignedManifest(owner, "profile.json", "cached", keys, 1000.0)
			val newer = buildSignedManifest(owner, "profile.json", "new", keys, 2000.0)
			// 新旧两版明文块均预存，chunk miss 不依赖网络
			storeManifestParts(older, encryptPlaintextToParts("cached".toByteArray(Charsets.UTF_8), "convergent").parts.map { it["raw"] as ByteArray })
			storeManifestParts(newer, encryptPlaintextToParts("new".toByteArray(Charsets.UTF_8), "convergent").parts.map { it["raw"] as ByteArray })
			cachePublicManifest(owner, "profile.json", older)

			coroutineScope {
				val readDeferred = async {
					readPublicFile("u", owner, "profile.json", ReadPublicFileOptions(revalidate = true))
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to newer)))
				assertEquals("new", readDeferred.await()?.toString(Charsets.UTF_8))
			}
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `readPublicFile forwards fanoutTargets to manifest and chunk fetch`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-read-pub-targeted-") {
			val keys = testRecoveryKeys(35)
			val owner = entityHashFromRecoveryPubKeyHex("f4".repeat(32), keys.pubKeyHex)
			val signed = buildSignedManifest(owner, "profile.json", "targeted", keys, 2500.0)
			val targetNodeHash = "f5".repeat(32)

			var chunkFanoutTargets: List<Any?>? = null
			coroutineScope {
				val readDeferred = async {
					readPublicFile(
						"u",
						owner,
						"profile.json",
						ReadPublicFileOptions(
							fanoutTargets = listOf(targetNodeHash),
							fetchChunk = { context ->
								chunkFanoutTargets = context["fanoutTargets"] as? List<Any?>
								// 返回 null 让 chunk miss 继续走 fanout；此处只验证转发
								null
							},
						),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				// 定向 manifest fetch 接受目标集外 sender 的 public 响应（验签仍通过）
				assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to signed)))
				// mock fetchChunk 返回 null → 明文读取失败，readPromise 结算为 null
				assertNull(readDeferred.await())
			}
			// chunk 拉取收到同一目标集（fanoutTargets 已从 options 转发到 fetchChunk）
			assertEquals(listOf(targetNodeHash), chunkFanoutTargets)
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest cold miss still awaits fanout`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-cold-") {
			val keys = testRecoveryKeys(16)
			val owner = entityHashFromRecoveryPubKeyHex("d".repeat(64), keys.pubKeyHex)
			val signed = buildSignedManifest(owner, "profile.json", "cold", keys, 3000.0)

			coroutineScope {
				val fetchDeferred = async {
					fetchManifest(
						mapOf(
							"username" to "u",
							"ownerEntityHash" to owner,
							"logicalPath" to "profile.json",
							"cache" to true,
						),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to signed)))
				assertEquals(3000.0, publishedAtOf(fetchDeferred.await()))
			}
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest dedups concurrent in-flight by username owner path`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-dedup-") {
			val keys = testRecoveryKeys(17)
			val owner = entityHashFromRecoveryPubKeyHex("e".repeat(64), keys.pubKeyHex)
			val signed = buildSignedManifest(owner, "profile.json", "once", keys, 3000.0)

			coroutineScope {
				val first = async {
					fetchManifest(
						mapOf("username" to "u", "ownerEntityHash" to owner, "logicalPath" to "profile.json", "cache" to true),
					)
				}
				val second = async {
					fetchManifest(
						mapOf("username" to "u", "ownerEntityHash" to owner, "logicalPath" to "profile.json", "cache" to true),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				assertEquals(1, pendingManifestFetches.size)

				assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to signed)))
				assertEquals(3000.0, publishedAtOf(first.await()))
				assertEquals(3000.0, publishedAtOf(second.await()))
			}
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest targeted cold miss resolves non-public and caches locally`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-tgt-nonpub-") {
			val owner = entityHashFromRecoveryPubKeyHex("f".repeat(64), testRecoveryKeys(20).pubKeyHex)
			val manifest = buildNonPublicManifest(owner, "chat/file-1", "secret", "file-master-key-wrap")

			coroutineScope {
				val fetchDeferred = async {
					fetchManifest(
						mapOf(
							"username" to "u",
							"ownerEntityHash" to owner,
							"logicalPath" to "chat/file-1",
							"fanoutTargets" to listOf("b".repeat(64)),
						),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				assertEquals(
					true,
					resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to manifest, "senderNodeHash" to "b".repeat(64))),
				)
				val got = fetchDeferred.await()
				@Suppress("UNCHECKED_CAST")
				val descriptor = got?.get("transferKeyDescriptor") as Map<String, Any?>
				assertEquals("file-master-key-wrap", descriptor["type"])
				@Suppress("UNCHECKED_CAST")
				val gotMeta = got["meta"] as Map<String, Any?>
				assertEquals("g1", gotMeta["groupId"])
			}
			// targeted 命中默认落盘
			val cached = loadFileManifest(owner, "chat/file-1")
			@Suppress("UNCHECKED_CAST")
			val cachedDescriptor = cached?.get("transferKeyDescriptor") as Map<*, *>
			assertEquals("file-master-key-wrap", cachedDescriptor["type"])
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest targeted accepts signed public response too`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-tgt-public-") {
			val keys = testRecoveryKeys(21)
			val owner = entityHashFromRecoveryPubKeyHex("1".repeat(64), keys.pubKeyHex)
			val signed = buildSignedManifest(owner, "profile.json", "pub", keys, 4000.0)

			coroutineScope {
				val fetchDeferred = async {
					fetchManifest(
						mapOf(
							"username" to "u",
							"ownerEntityHash" to owner,
							"logicalPath" to "profile.json",
							"fanoutTargets" to listOf("2".repeat(64)),
						),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				assertEquals(true, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to signed)))
				assertEquals(4000.0, publishedAtOf(fetchDeferred.await()))
			}
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest public mode refuses non-public response`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-refuse-nonpub-") {
			val owner = entityHashFromRecoveryPubKeyHex("3".repeat(64), testRecoveryKeys(22).pubKeyHex)
			val manifest = buildNonPublicManifest(owner, "chat/file-1", "secret", "file-master-key-wrap")

			coroutineScope {
				val fetchDeferred = async {
					fetchManifest(
						mapOf(
							"username" to "u",
							"ownerEntityHash" to owner,
							"logicalPath" to "chat/file-1",
							"timeoutMs" to 500,
						),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				assertEquals(false, resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to manifest)))
				assertNull(fetchDeferred.await())
			}
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest targeted returns local non-public manifest immediately without fanout wait`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-local-nonpub-") {
			val owner = entityHashFromRecoveryPubKeyHex("4".repeat(64), testRecoveryKeys(23).pubKeyHex)
			getEntityStore().writeManifest(owner, "vault/secret.bin", buildNonPublicManifest(owner, "vault/secret.bin", "secret", "vault-wrap"))

			val started = System.currentTimeMillis()
			val result = fetchManifest(
				mapOf(
					"username" to "u",
					"ownerEntityHash" to owner,
					"logicalPath" to "vault/secret.bin",
					"fanoutTargets" to listOf("10".repeat(32)),
				),
			)
			@Suppress("UNCHECKED_CAST")
			val descriptor = result?.get("transferKeyDescriptor") as Map<String, Any?>
			assertEquals("vault-wrap", descriptor["type"])
			assertEquals(true, System.currentTimeMillis() - started < 500)
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest targeted dedups concurrent in-flight`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-tgt-dedup-") {
			val owner = entityHashFromRecoveryPubKeyHex("5".repeat(64), testRecoveryKeys(24).pubKeyHex)
			val manifest = buildNonPublicManifest(owner, "chat/file-1", "secret", "file-master-key-wrap")
			val targets = listOf("6".repeat(64))

			coroutineScope {
				val first = async {
					fetchManifest(
						mapOf("username" to "u", "ownerEntityHash" to owner, "logicalPath" to "chat/file-1", "fanoutTargets" to targets),
					)
				}
				val second = async {
					fetchManifest(
						mapOf("username" to "u", "ownerEntityHash" to owner, "logicalPath" to "chat/file-1", "fanoutTargets" to targets),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				assertEquals(1, pendingManifestFetches.size)
				assertEquals(
					true,
					resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to manifest, "senderNodeHash" to "6".repeat(64))),
				)
				@Suppress("UNCHECKED_CAST")
				val firstDescriptor = first.await()?.get("transferKeyDescriptor") as Map<String, Any?>
				@Suppress("UNCHECKED_CAST")
				val secondDescriptor = second.await()?.get("transferKeyDescriptor") as Map<String, Any?>
				assertEquals("file-master-key-wrap", firstDescriptor["type"])
				assertEquals("file-master-key-wrap", secondDescriptor["type"])
			}
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest targeted rejects non-public response from sender outside target set`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-tgt-sender-reject-") {
			val owner = entityHashFromRecoveryPubKeyHex("7".repeat(64), testRecoveryKeys(25).pubKeyHex)
			val manifest = buildNonPublicManifest(owner, "chat/file-1", "secret", "file-master-key-wrap")

			coroutineScope {
				val fetchDeferred = async {
					fetchManifest(
						mapOf(
							"username" to "u",
							"ownerEntityHash" to owner,
							"logicalPath" to "chat/file-1",
							"fanoutTargets" to listOf("8".repeat(64)),
						),
					)
				}
				val requestId = waitForPendingManifestRequestId()
				assertEquals(true, requestId != null)
				// 注入：sender 不在目标集 → 拒绝
				assertEquals(
					false,
					resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to manifest, "senderNodeHash" to "9".repeat(64))),
				)
				// 目标集内 sender → 接受
				assertEquals(
					true,
					resolvePendingManifestFetch(mapOf("requestId" to requestId, "manifest" to manifest, "senderNodeHash" to "8".repeat(64))),
				)
				@Suppress("UNCHECKED_CAST")
				val descriptor = fetchDeferred.await()?.get("transferKeyDescriptor") as Map<String, Any?>
				assertEquals("file-master-key-wrap", descriptor["type"])
			}
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fetchManifest targeted does not dedup different target sets`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-tgt-key-") {
			val owner = entityHashFromRecoveryPubKeyHex("ab".repeat(32), testRecoveryKeys(26).pubKeyHex)

			coroutineScope {
				val first = async {
					fetchManifest(
						mapOf("username" to "u", "ownerEntityHash" to owner, "logicalPath" to "chat/file-1", "fanoutTargets" to listOf("cd".repeat(32))),
					)
				}
				val second = async {
					fetchManifest(
						mapOf("username" to "u", "ownerEntityHash" to owner, "logicalPath" to "chat/file-1", "fanoutTargets" to listOf("ef".repeat(32))),
					)
				}
				waitUntil { pendingManifestFetches.size >= 2 }
				assertEquals(2, pendingManifestFetches.size)
				settleAllPendingManifestFetches()
				first.await()
				second.await()
			}
		}
	}

	@Test
	fun `fetchManifest public mode refuses local non-public manifest`() = runBlocking {
		settleAllPendingManifestFetches()
		withTempNode("fount-fetch-pub-refuse-local-nonpub-") {
			val owner = entityHashFromRecoveryPubKeyHex("de".repeat(32), testRecoveryKeys(27).pubKeyHex)
			getEntityStore().writeManifest(owner, "vault/secret.bin", buildNonPublicManifest(owner, "vault/secret.bin", "secret", "vault-wrap"))

			assertNull(
				fetchManifest(
					mapOf(
						"username" to "u",
						"ownerEntityHash" to owner,
						"logicalPath" to "vault/secret.bin",
					),
				),
			)
			settleAllPendingManifestFetches()
		}
	}

	@Test
	fun `fed_manifest_get serves fanout request with requester differing from target node`() = runBlocking {
		withTempNode("fount-fed-manifest-fanout-") {
			val owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(28).pubKeyHex)
			val plaintext = "secret".toByteArray(Charsets.UTF_8)
			getEntityStore().writeManifest(
				owner,
				"vault/secret.bin",
				buildFileManifestFromEnc(
					mapOf(
						"ownerEntityHash" to owner,
						"logicalPath" to "vault/secret.bin",
						"plaintext" to plaintext,
						"name" to "secret.bin",
						"mimeType" to "application/octet-stream",
						"ceMode" to "convergent",
						"transferKeyDescriptor" to mapOf("type" to "vault-wrap", "entityHash" to owner),
					),
					encryptPlaintextToParts(plaintext, "convergent"),
				),
			)

			var seen: ManifestServicerContext? = null
			registerManifestOwner("test") { _, ownerEntityHash -> ownerEntityHash == owner }
			registerManifestServicer("test") { context ->
				seen = context
				true
			}
			try {
				var response: Map<String, Any?>? = null
				val requesterNodeHash = "a".repeat(64)
				val targetNodeHash = "b".repeat(64)
				// fanout：同一请求发给多个目标节点；自报 nodeHash 指向目标节点，而认证方为请求方（二者不同）。
				// 服务端必须忽略自报字段，始终以传输层认证的 peerId 作为 requesterNodeHash。
				handleIncomingManifestGet(
					mapOf(
						"requestId" to "r4",
						"nodeHash" to targetNodeHash,
						"ownerEntityHash" to owner,
						"logicalPath" to "vault/secret.bin",
					),
					{ payload, _ -> response = payload },
					requesterNodeHash,
				)
				assertEquals("r4", response?.get("requestId"))
				assertEquals(requesterNodeHash, seen?.requesterNodeHash)
				assertEquals(requesterNodeHash, seen?.peerId)
				assertEquals("vault/secret.bin", seen?.logicalPath)
			}
			finally {
				unregisterManifestServicer("test")
				unregisterManifestOwner("test")
			}
		}
	}

	@Test
	fun `fed_manifest_get routes non-public by matcher owner, not by type`() = runBlocking {
		withTempNode("fount-fed-manifest-owner-route-") {
			// chat 与 cabinet 同用 file-master-key-wrap；各自 matcher 收窄到自己的实体
			val chatGroup = logicalEntityHash("fount:chat:group:g1")
			val cabinetShared = logicalEntityHash("fount:cabinet:shared:c1")
			val noFamilyOwner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(30).pubKeyHex)
			for ((ownerEntityHash, logicalPath) in listOf(
				chatGroup to "chat/file-1",
				cabinetShared to "shared/file-1",
				noFamilyOwner to "nofamily/file-1",
			))
				getEntityStore().writeManifest(
					ownerEntityHash,
					logicalPath,
					buildNonPublicManifest(ownerEntityHash, logicalPath, "secret", "file-master-key-wrap"),
				)

			val served = ArrayList<String>()
			registerManifestOwner("chat") { _, ownerEntityHash -> ownerEntityHash == chatGroup }
			registerManifestOwner("cabinet") { _, ownerEntityHash -> ownerEntityHash == cabinetShared }
			registerManifestServicer("chat") { served.add("chat"); true }
			registerManifestServicer("cabinet") { served.add("cabinet"); true }

			suspend fun serve(ownerEntityHash: String, logicalPath: String): Map<String, Any?>? {
				var response: Map<String, Any?>? = null
				handleIncomingManifestGet(
					mapOf("requestId" to "r", "ownerEntityHash" to ownerEntityHash, "logicalPath" to logicalPath),
					{ payload, _ -> response = payload },
					"peer",
				)
				return response
			}

			try {
				// 相同 type 两族并存：chat 文件 → chat servicer，cabinet 文件 → cabinet servicer
				@Suppress("UNCHECKED_CAST")
				val chatResponse = serve(chatGroup, "chat/file-1")?.get("manifest") as Map<String, Any?>
				assertEquals(chatGroup, chatResponse["ownerEntityHash"])
				assertEquals(listOf("chat"), served)
				@Suppress("UNCHECKED_CAST")
				val cabinetResponse = serve(cabinetShared, "shared/file-1")?.get("manifest") as Map<String, Any?>
				assertEquals(cabinetShared, cabinetResponse["ownerEntityHash"])
				assertEquals(listOf("chat", "cabinet"), served)
				// 无 matcher 命中：即使该 type 已有 servicer，也一律 deny（不再按 type 兜底路由）
				assertNull(serve(noFamilyOwner, "nofamily/file-1"))
				assertEquals(listOf("chat", "cabinet"), served)
			}
			finally {
				unregisterManifestServicer("chat")
				unregisterManifestServicer("cabinet")
				unregisterManifestOwner("chat")
				unregisterManifestOwner("cabinet")
			}
		}
	}
}
