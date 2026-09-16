/**
 * 跨端 Ed25519 / SHA-256（Node 与浏览器共用；不依赖 node:crypto）。
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { bytesToHex, toBytes } from '../core/bytes_codec.mjs'

/**
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer|string} data 字节或 UTF-8 文本
 * @returns {Uint8Array} 规范化字节
 */
function inputBytes(data) {
	if (typeof data === 'string') return new TextEncoder().encode(data)
	return toBytes(data)
}

/**
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer} seed 任意长度；非 32 字节时 sha256 派生
 * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }} 32 字节私钥与对应公钥
 */
export function keyPairFromSeed(seed) {
	const u = toBytes(seed)
	const sk = u.length === 32 ? u : sha256(u)
	return { publicKey: ed25519.getPublicKey(sk), secretKey: new Uint8Array(sk) }
}

/**
 * @returns {Promise<{ publicKey: Uint8Array, secretKey: Uint8Array }>} 随机密钥对
 */
export async function randomKeyPair() {
	const sk = new Uint8Array(32)
	globalThis.crypto.getRandomValues(sk)
	return keyPairFromSeed(sk)
}

/**
 * @param {Uint8Array} secretKey 私钥种子
 * @returns {Uint8Array} 公钥
 */
export function publicKeyFromSeed(secretKey) {
	return ed25519.getPublicKey(toBytes(secretKey).subarray(0, 32))
}

/**
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer|string} message 待签名消息
 * @param {Uint8Array} secretKey 私钥（取前 32 字节为种子）
 * @returns {Promise<Uint8Array>} 64 字节签名
 */
export async function sign(message, secretKey) {
	return ed25519.sign(inputBytes(message), toBytes(secretKey).subarray(0, 32))
}

/**
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer} signature 64 字节签名
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer|string} message 原始消息
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer} publicKey 公钥
 * @returns {Promise<boolean>} 合法为 true；异常或失败为 false
 */
export async function verify(signature, message, publicKey) {
	try {
		return ed25519.verify(toBytes(signature), inputBytes(message), toBytes(publicKey))
	}
	catch {
		return false
	}
}

/**
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer} publicKey 公钥字节
 * @returns {string} 64 字符 hex
 */
export function pubKeyHash(publicKey) {
	return bytesToHex(sha256(toBytes(publicKey)))
}

/**
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer|string} data 字节或 UTF-8 文本
 * @returns {string} 64 字符 hex
 */
export function sha256Hex(data) {
	return bytesToHex(sha256(inputBytes(data)))
}
