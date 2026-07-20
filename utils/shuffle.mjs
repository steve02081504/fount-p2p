/**
 * Fisher–Yates 原地洗牌。
 * @template T
 * @param {T[]} arr 待洗牌数组（原地修改）
 * @returns {T[]} 同一数组引用
 */
export function shuffleInPlace(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[arr[i], arr[j]] = [arr[j], arr[i]]
	}
	return arr
}
