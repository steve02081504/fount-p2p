package io.github.steve02081504.fountp2p.utils

import kotlin.random.Random

/**
 * Fisher–Yates 原地洗牌。
 * @param arr 待洗牌数组（原地修改）
 * @return 同一数组引用
 */
fun <T> shuffleInPlace(arr: MutableList<T>): MutableList<T> {
	for (i in arr.size - 1 downTo 1) {
		val j = Random.nextInt(i + 1)
		val tmp = arr[i]
		arr[i] = arr[j]
		arr[j] = tmp
	}
	return arr
}
