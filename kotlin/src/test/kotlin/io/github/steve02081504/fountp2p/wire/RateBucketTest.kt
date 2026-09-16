package io.github.steve02081504.fountp2p.wire

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.UUID

/** 等价 `test/pure/wire_rate_bucket.test.mjs`。 */
class RateBucketTest {
	private fun key(prefix: String): String = "$prefix-${UUID.randomUUID()}"

	@Test
	fun `consumeWireRateBucket allows first consumption`() {
		val bucketKey = key("bucket-first")
		assertEquals(true, consumeWireRateBucket(bucketKey, mapOf("maxCount" to 5.0)))
	}

	@Test
	fun `consumeWireRateBucket rejects when count budget exhausted`() {
		val bucketKey = key("bucket-count")
		val limits = mapOf<String, Any?>("maxCount" to 2.0)
		assertEquals(true, consumeWireRateBucket(bucketKey, limits))
		assertEquals(true, consumeWireRateBucket(bucketKey, limits))
		assertEquals(false, consumeWireRateBucket(bucketKey, limits))
	}

	@Test
	fun `consumeWireRateBucket refills tokens after window elapses`() {
		val bucketKey = key("bucket-refill")
		val limits = mapOf<String, Any?>("maxCount" to 1.0)
		var now = 5_000_000L
		assertEquals(true, consumeWireRateBucket(bucketKey, limits, now))
		assertEquals(false, consumeWireRateBucket(bucketKey, limits, now))
		now += 60_001
		assertEquals(true, consumeWireRateBucket(bucketKey, limits, now))
	}

	@Test
	fun `consumeWireRateBucket enforces byte budget when configured`() {
		val bucketKey = key("bucket-bytes")
		val limits = mapOf<String, Any?>(
			"maxCount" to 10.0,
			"maxBytesPerWindow" to 1000.0,
			"byteCount" to 600.0,
		)
		assertEquals(true, consumeWireRateBucket(bucketKey, limits))
		assertEquals(false, consumeWireRateBucket(bucketKey, limits))
	}
}
