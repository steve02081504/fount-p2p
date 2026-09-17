package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.core.bytesToBase64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/link_frame.test.mjs`。 */
class FrameTest {
	@Test
	fun `encodeFrames and createReassembler round trip a multi frame payload`() {
		val payload = ByteArray(40_000) { 'x'.code.toByte() }
		val frames = encodeFrames("ab".repeat(16), payload)
		assertTrue(frames.size > 1)
		val first = decodeFrame(frames[0])
		assertEquals("ab".repeat(16), first.frameId)
		assertEquals(0, first.seq)
		assertEquals(frames.size, first.total)
		val reassembler = createReassembler()
		var merged: ByteArray? = null
		for (frame in frames) merged = reassembler.push(frame)
		assertArrayEquals(payload, merged)
	}

	@Test
	fun `reassembler clear drops partial state`() {
		val payload = ByteArray(20_000) { 'y'.code.toByte() }
		val frames = encodeFrames("cd".repeat(16), payload)
		val reassembler = createReassembler(Reassembler.ReassemblerOptions(partialTimeoutMs = 10))
		assertNull(reassembler.push(frames[0], 0))
		assertEquals(1, reassembler.size())
		reassembler.clear()
		assertEquals(0, reassembler.size())
	}

	@Test
	fun `maxFrameChunkBytesForPayload fits base64 under the cap and maximizes usage`() {
		val limit = 131072
		val chunk = maxFrameChunkBytesForPayload(limit)
		assertTrue(bytesToBase64(ByteArray(FRAME_HEADER_BYTES + chunk)).length <= limit)
		assertTrue(bytesToBase64(ByteArray(FRAME_HEADER_BYTES + chunk + 1)).length > limit)
	}

	@Test
	fun `maxFrameChunkBytesForPayload handles small caps without overflow`() {
		for (limit in listOf(32, 100, 1024, 4096, 12 * 1024)) {
			val chunk = maxFrameChunkBytesForPayload(limit)
			assertTrue(bytesToBase64(ByteArray(FRAME_HEADER_BYTES + chunk)).length <= limit)
			assertTrue(bytesToBase64(ByteArray(FRAME_HEADER_BYTES + chunk + 1)).length > limit)
		}
		assertEquals(0, maxFrameChunkBytesForPayload(1))
	}

	@Test
	fun `encodeFrames with payload derived chunk reassembles and every frame fits the cap`() {
		val payload = ByteArray(200_000) { 'w'.code.toByte() }
		val chunk = maxFrameChunkBytesForPayload(131072)
		val frames = encodeFrames("ab".repeat(16), payload, chunk)
		assertTrue(frames.size > 1)
		for (frame in frames) assertTrue(bytesToBase64(frame).length <= 131072)
		val reassembler = createReassembler()
		var merged: ByteArray? = null
		for (frame in frames) merged = reassembler.push(frame)
		assertArrayEquals(payload, merged)
	}

	@Test
	fun `reassembler rejects oversized messages`() {
		val payload = ByteArray(20_000) { 'z'.code.toByte() }
		val frame = encodeFrames("ef".repeat(16), payload)[0]
		val reassembler = createReassembler(Reassembler.ReassemblerOptions(maxMessageBytes = 1024))
		assertThrows(IllegalStateException::class.java) { reassembler.push(frame) }
	}
}
