import { test } from 'node:test'

import { bytesToBase64 } from '../../core/bytes_codec.mjs'
import { createReassembler, decodeFrame, encodeFrames, FRAME_HEADER_BYTES, maxFrameChunkBytesForPayload } from '../../link/frame.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'



test('encodeFrames and createReassembler round-trip a multi-frame payload', () => {
	const payload = new TextEncoder().encode('x'.repeat(40_000))
	const frames = encodeFrames('ab'.repeat(16), payload)
	assertEquals(frames.length > 1, true)
	const first = decodeFrame(frames[0])
	assertEquals(first.frameId, 'ab'.repeat(16))
	assertEquals(first.seq, 0)
	assertEquals(first.total, frames.length)
	const reassembler = createReassembler()
	let merged = null
	for (const frame of frames)
		merged = reassembler.push(frame)
	assertEquals(new TextDecoder().decode(merged), new TextDecoder().decode(payload))
})

test('reassembler clear drops partial state', () => {
	const payload = new TextEncoder().encode('y'.repeat(20_000))
	const frames = encodeFrames('cd'.repeat(16), payload)
	const reassembler = createReassembler({ partialTimeoutMs: 10 })
	assertEquals(reassembler.push(frames[0], 0), null)
	assertEquals(reassembler.size(), 1)
	reassembler.clear()
	assertEquals(reassembler.size(), 0)
})

test('maxFrameChunkBytesForPayload fits base64 under the cap and maximizes usage', () => {
	const limit = 131072
	const chunk = maxFrameChunkBytesForPayload(limit)
	assertEquals(bytesToBase64(new Uint8Array(FRAME_HEADER_BYTES + chunk)).length <= limit, true)
	assertEquals(bytesToBase64(new Uint8Array(FRAME_HEADER_BYTES + chunk + 1)).length > limit, true)
})

test('maxFrameChunkBytesForPayload handles small caps without overflow', () => {
	for (const limit of [32, 100, 1024, 4096, 12 * 1024]) {
		const chunk = maxFrameChunkBytesForPayload(limit)
		assertEquals(bytesToBase64(new Uint8Array(FRAME_HEADER_BYTES + chunk)).length <= limit, true)
		assertEquals(bytesToBase64(new Uint8Array(FRAME_HEADER_BYTES + chunk + 1)).length > limit, true)
	}
	// 上限连帧头都装不下时退化为 0，且不为负。
	assertEquals(maxFrameChunkBytesForPayload(1), 0)
})

test('encodeFrames with payload-derived chunk reassembles and every frame fits the cap', () => {
	const payload = new TextEncoder().encode('w'.repeat(200_000))
	const chunk = maxFrameChunkBytesForPayload(131072)
	const frames = encodeFrames('ab'.repeat(16), payload, chunk)
	assertEquals(frames.length > 1, true)
	for (const frame of frames)
		assertEquals(bytesToBase64(frame).length <= 131072, true)
	const reassembler = createReassembler()
	let merged = null
	for (const frame of frames)
		merged = reassembler.push(frame)
	assertEquals(new TextDecoder().decode(merged), new TextDecoder().decode(payload))
})

test('reassembler rejects oversized messages', async () => {
	const payload = new TextEncoder().encode('z'.repeat(20_000))
	const frame = encodeFrames('ef'.repeat(16), payload)[0]
	const reassembler = createReassembler({ maxMessageBytes: 1024 })
	await assert.rejects(async () => {
		reassembler.push(frame)
	})
})
