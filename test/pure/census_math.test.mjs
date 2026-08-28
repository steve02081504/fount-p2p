import { test } from 'node:test'

import {
	CENSUS_GROW_FACTOR,
	CENSUS_MIN_P,
	CENSUS_TARGET_EVENTS,
	clampP,
	estimatePopulation,
	nextInclusionProbability,
} from '../../discovery/nostr/census_math.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/** 确定性 PRNG（mulberry32），保证反馈模拟测试非 flaky。 */
function makeRng(seed) {
	return () => {
		seed = (seed + 0x6D2B79F5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * 模拟多节点多回合 census 反馈（完全连通、每节点独立 p、首轮窗口为空）。
 * @param {number} seed PRNG 种子
 * @param {number} initial 初始节点数
 * @param {(round: number, alive: number) => number} deltaPerRound 每回合净增节点数（负为退网）
 * @param {number} rounds 回合数
 * @returns {{ estimates: number[], eventCounts: number[] }} 每回合 HT 估计与事件数
 */
function simulateCensus(seed, initial, deltaPerRound, rounds) {
	const rng = makeRng(seed)
	const target = CENSUS_TARGET_EVENTS
	/** @type {Array<number>} */
	const p = Array(initial).fill(0.5)
	let observed = 0
	const estimates = []
	const eventCounts = []
	for (let round = 0; round < rounds; round++) {
		const delta = deltaPerRound(round, p.length)
		if (delta > 0) for (let index = 0; index < delta; index++) p.push(0.5)
		else for (let index = 0; index < -delta; index++) p.pop()
		for (let index = 0; index < p.length; index++)
			p[index] = nextInclusionProbability(p[index], observed, target)
		const events = []
		for (let index = 0; index < p.length; index++)
			if (rng() < p[index]) events.push({ p: p[index], at: Date.now() })
		observed = events.length
		eventCounts.push(observed)
		estimates.push(estimatePopulation(events).estimate)
	}
	return { estimates, eventCounts }
}

test('HT estimate matches known populations', () => {
	// p = 20/M 均匀采样：Σ(1/p) 应回到 M（近似）。
	const estimate = events => estimatePopulation(events)
	for (const M of [20, 200, 2000]) {
		const p = CENSUS_TARGET_EVENTS / M
		const events = Array.from({ length: CENSUS_TARGET_EVENTS }, (_, index) => ({
			p,
			at: Date.now() - index,
		}))
		const { estimate: total, sampleSize } = estimate(events)
		assertEquals(total, M)
		assertEquals(sampleSize, CENSUS_TARGET_EVENTS)
	}
})

test('estimatePopulation ignores invalid or expired events', () => {
	const now = Date.now()
	const events = [
		{ p: 0.1, at: now },
		{ p: 0, at: now },
		{ p: 2, at: now },
		{ p: 'x', at: now },
		{ p: null, at: now },
		{ p: 0.1, at: now - 11 * 60_000 },
	]
	const { estimate, sampleSize } = estimatePopulation(events, now, 10 * 60_000)
	assertEquals(estimate, 10)
	assertEquals(sampleSize, 1)
})

test('200-node feedback loop: event count regresses to ~target while estimate stays ~200', () => {
	const M = 200
	const T = CENSUS_TARGET_EVENTS

	for (const seed of [0x1, 0xC0FFEE, 0xF00D, 0xABCD]) {
		const rng = makeRng(seed)
		// 每节点本地包含概率，初始 CENSUS_INITIAL_P = 0.5。
		const p = Array(M).fill(0.5)
		let observed = 0
		/** @type {Array<number>} */
		const rounds = []
		/** @type {Array<number>} */
		const estimates = []
		for (let round = 0; round < 15; round++) {
			for (let i = 0; i < M; i++)
				p[i] = nextInclusionProbability(p[i], observed, T)
			const events = []
			for (let i = 0; i < M; i++)
				if (rng() < p[i]) events.push({ p: p[i], at: Date.now() })
			observed = events.length
			const { estimate } = estimatePopulation(events)
			rounds.push(observed)
			estimates.push(estimate)
		}
		// 首轮空窗口探测增长 → 大量节点带高 p 发布（E 远大于 T）。
		assertEquals(rounds[0] >= 80, true, `seed ${seed} first-round events ${rounds[0]}`)
		// 次轮起 E 回归到 ~T（20 条），估计值始终 ~M（200）。
		const laterRounds = rounds.slice(1)
		const laterEstimates = estimates.slice(1)
		const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
		assertEquals(mean(laterRounds) >= 12 && mean(laterRounds) <= 30, true,
			`seed ${seed} mean later events ${mean(laterRounds)}`)
		assertEquals(mean(laterEstimates) >= 170 && mean(laterEstimates) <= 230, true,
			`seed ${seed} mean later estimate ${mean(laterEstimates)}`)
		assertEquals(estimates[0] >= 170 && estimates[0] <= 230, true,
			`seed ${seed} first-round estimate ${estimates[0]}`)
	}
})

test('multiplicative update converges event count toward target', () => {
	// 模拟若干轮：每轮发布 E = M·p 条，p 按 T/E 缩放；事件数应逼近 T。
	let p = 0.5
	const M = 200
	const observed = []
	for (let round = 0; round < 200; round++) {
		observed.push(Math.round(M * p))
		p = nextInclusionProbability(p, observed[observed.length - 1], CENSUS_TARGET_EVENTS)
	}
	const last = observed[observed.length - 1]
	assertEquals(last >= 15 && last <= 25, true, `last event count ${last}`)
})

test('E==0 grows probability up to 1', () => {
	const grown = nextInclusionProbability(0.1, 0, CENSUS_TARGET_EVENTS)
	assertEquals(grown, 0.1 * CENSUS_GROW_FACTOR)
	assertEquals(nextInclusionProbability(1, 0, CENSUS_TARGET_EVENTS), 1)
})

test('update clamps into [minP, 1]', () => {
	assertEquals(nextInclusionProbability(0.5, 100_000, CENSUS_TARGET_EVENTS), CENSUS_MIN_P)
	assertEquals(nextInclusionProbability(0.5, 1, CENSUS_TARGET_EVENTS), 1)
	// NaN 概率回落 minP 后再按 T/E 缩放
	assertEquals(nextInclusionProbability(Number.NaN, 5, CENSUS_TARGET_EVENTS), CENSUS_MIN_P * 4)
})

test('clampP handles invalid input', () => {
	assertEquals(clampP(-1), CENSUS_MIN_P)
	assertEquals(clampP(1.5), 1)
	assertEquals(clampP(Number.NaN), CENSUS_MIN_P)
	assertEquals(clampP(undefined), CENSUS_MIN_P)
})

test('census estimate tracks population through gradual join (to 2000) and churn (to 1000)', () => {
	const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
	// 200 起步，6 回合每回合 +300 到 2000，hold 10 回合；再 5 回合每回合 -200 到 1000，hold 10 回合。
	const timeline = (round, alive) => {
		if (round < 6) return 300
		if (round < 16) return 0
		if (round < 21) return -200
		return 0
	}
	// 单窗 HT 估计方差大（minP 钳制的对端事件单条值 1000，重尾），故断言跨种子均值：
	// 无偏估计应贴合真实人口 2000 / 1000，且退网后均值跌落。
	const joinedMeans = []
	const churnedMeans = []
	for (let seed = 1; seed <= 100; seed++) {
		const { estimates } = simulateCensus(seed, 200, timeline, 31)
		joinedMeans.push(mean(estimates.slice(10, 16)))
		churnedMeans.push(mean(estimates.slice(26, 31)))
	}
	assertEquals(mean(joinedMeans) >= 1900 && mean(joinedMeans) <= 2100, true,
		`joined mean ${mean(joinedMeans)}`)
	assertEquals(mean(churnedMeans) >= 950 && mean(churnedMeans) <= 1050, true,
		`churned mean ${mean(churnedMeans)}`)
	assertEquals(mean(churnedMeans) < mean(joinedMeans), true, 'churned mean did not drop below joined mean')
})