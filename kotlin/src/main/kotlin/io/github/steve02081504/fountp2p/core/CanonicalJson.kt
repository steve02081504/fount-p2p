package io.github.steve02081504.fountp2p.core

/**
 * 确定性 JSON 序列化（键排序），用于 event id 与验签负载。
 * @param value 任意可 JSON 化的结构（禁止特别类型）
 * @return 键已排序的紧凑 JSON 文本
 */
fun canonicalStringify(value: Any?): String = Json.stringifyCanonical(value)
