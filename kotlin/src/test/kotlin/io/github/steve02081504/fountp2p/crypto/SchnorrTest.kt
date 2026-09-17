package io.github.steve02081504.fountp2p.crypto

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BIP340 Schnorr 等价测试。
 *
 * 期望值由 JS 侧 `@noble/curves/secp256k1` 的 `schnorr`（本仓库运行时的同一实现）生成，
 * 保证 Kotlin 与 JS 事件签名逐字节一致。
 */
class SchnorrTest {
	private class Vector(
		val secretKey: String,
		val publicKey: String,
		val auxRand: String,
		val message: String,
		val signature: String,
	)

	private val vectors = listOf(
		Vector(
			secretKey = "050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7de",
			publicKey = "4fa4ce374b6ba63c90047d64053704df0428f05595dc7b882790d0e8bb8c8268",
			auxRand = "0104070a0d101316191c1f2225282b2e3134373a3d404346494c4f5255585b5e",
			message = "03101d2a3744515e6b7885929facb9c6d3e0edfa0714212e3b4855626f7c8996",
			signature = "a871df147c498d5ac6390b5fed5ff44e9d9823b2d4bd920ed41714df2dbd3d8a72e59f0074d5d27c271c92bc032d723ea6454338fc773441c01e5f2a1249832f",
		),
		Vector(
			secretKey = "242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd",
			publicKey = "f74c082609ebb736fd833324af605d7d9e3fb2b1ee800d5a0961f8895ba60e73",
			auxRand = "0c0f1215181b1e2124272a2d303336393c3f4245484b4e5154575a5d60636669",
			message = "14212e3b4855626f7c8996a3b0bdcad7e4f1fe0b1825323f4c596673808d9aa7",
			signature = "1f496ae38ebcdf8d18fd2d1cfc4bbf240f52d4379acfeb9ea32578ebfd5f474506843da7f3c3d8b351a59d362deb3befab4889d524b13152f6d372f07f3913ec",
		),
		Vector(
			secretKey = "434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c",
			publicKey = "151b94809c7f056a59ea0396800b660915aec4f6201b451e6bb9745542fa0d2c",
			auxRand = "171a1d202326292c2f3235383b3e4144474a4d505356595c5f6265686b6e7174",
			message = "25323f4c596673808d9aa7b4c1cedbe8f5020f1c293643505d6a7784919eabb8",
			signature = "252fc5a2a5e44b607954fa603600de15c5f2b7b72e544ea576fda924e1582f890090f8c7a83efe98431dfed2108cdd7a9a96ed8ce04bd1afea3891f9ddaac3d2",
		),
		Vector(
			secretKey = "626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5fc030a11181f262d343b",
			publicKey = "38b70d845cce656290259866293f275b09fae3da746f047542520040b2e801f3",
			auxRand = "2225282b2e3134373a3d404346494c4f5255585b5e6164676a6d707376797c7f",
			message = "3643505d6a7784919eabb8c5d2dfecf90613202d3a4754616e7b8895a2afbcc9",
			signature = "f3c1f6c056d2f141a9d7a545d8bdd090e586ea3a2a8436a7a17e45aa8c8adc63ac8f48bd337f99eadec8b3cb10fc280569729098a8d8faf38e8c6b37f864caae",
		),
		Vector(
			secretKey = "81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a",
			publicKey = "d9fcd7b72796476bc402b1c303c6f20a058981447a709d2dee25d74b6f4b7eed",
			auxRand = "2d303336393c3f4245484b4e5154575a5d606366696c6f7275787b7e8184878a",
			message = "4754616e7b8895a2afbcc9d6e3f0fd0a1724313e4b5865727f8c99a6b3c0cdda",
			signature = "9ef6ccf4f72107415512252bd0dc993a7d536443514ff0795af0f4474a6bcf25501a4bf3a5b2ff0fb2d52a4a83d3e0e70f7162ae944c948fecc88e7bbf88d5d8",
		),
	)

	@Test
	fun `schnorrPublicKey matches noble vectors`() {
		for (vector in vectors)
			assertEquals(vector.publicKey, bytesToHex(schnorrPublicKey(hexToBytes(vector.secretKey))))
	}

	@Test
	fun `schnorrSign reproduces noble signatures byte for byte`() {
		for (vector in vectors) {
			val signature = schnorrSign(
				hexToBytes(vector.message),
				hexToBytes(vector.secretKey),
				hexToBytes(vector.auxRand),
			)
			assertArrayEquals(hexToBytes(vector.signature), signature)
		}
	}

	@Test
	fun `schnorrVerify accepts noble signatures`() {
		for (vector in vectors)
			assertTrue(
				schnorrVerify(
					hexToBytes(vector.message),
					hexToBytes(vector.signature),
					hexToBytes(vector.publicKey),
				),
			)
	}

	@Test
	fun `schnorrVerify rejects tampered message signature and key`() {
		val vector = vectors[0]
		val message = hexToBytes(vector.message)
		val signature = hexToBytes(vector.signature)
		val publicKey = hexToBytes(vector.publicKey)

		assertFalse(schnorrVerify(message.copyOf().also { it[0] = (it[0] + 1).toByte() }, signature, publicKey))
		assertFalse(schnorrVerify(message, signature.copyOf().also { it[63] = (it[63] + 1).toByte() }, publicKey))
		assertFalse(schnorrVerify(message, signature, publicKey.copyOf().also { it[31] = (it[31] + 1).toByte() }))
	}

	@Test
	fun `schnorrVerify rejects malformed inputs`() {
		val vector = vectors[0]
		assertFalse(schnorrVerify(hexToBytes(vector.message), ByteArray(63), hexToBytes(vector.publicKey)))
		assertFalse(schnorrVerify(hexToBytes(vector.message), hexToBytes(vector.signature), ByteArray(31)))
		// x 必须小于域特征 p。
		assertFalse(schnorrVerify(hexToBytes(vector.message), hexToBytes(vector.signature), hexToBytes("f".repeat(64))))
	}

	@Test
	fun `schnorrSign rejects out of range secret keys`() {
		for (bad in listOf("00".repeat(32), "f".repeat(64))) {
			var thrown = false
			try {
				schnorrSign(ByteArray(32), hexToBytes(bad), ByteArray(32))
			}
			catch (_: IllegalArgumentException) {
				thrown = true
			}
			assertTrue("expected rejection for $bad", thrown)
		}
	}
}
