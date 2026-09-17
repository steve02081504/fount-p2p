package io.github.steve02081504.fountp2p.discovery.nostr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/census_math.test.mjs`。 */
class CensusMathTest {
	private fun makeRng(seedInit: Int): () -> Double {
		var seed = seedInit
		return {
			seed = seed + 0x6D2B79F5
			var t = (seed xor (seed ushr 15)) * (1 or seed)
			t = (t + (t xor (t ushr 7)) * (61 or t)) xor t
			((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
		}
	}

	private fun simulateCensus(
		seed: Int,
		initial: Int,
		deltaPerRound: (Int) -> Int,
		rounds: Int,
	): Pair<List<Double>, List<Int>> {
		val rng = makeRng(seed)
		val target = CENSUS_TARGET_EVENTS
		val p = ArrayList<Double>()
		repeat(initial) { p.add(0.5) }
		var observed = 0
		val estimates = ArrayList<Double>()
		val eventCounts = ArrayList<Int>()
		for (round in 0 until rounds) {
			val delta = deltaPerRound(round)
			if (delta > 0) repeat(delta) { p.add(0.5) }
			else repeat(-delta) { if (p.isNotEmpty()) p.removeAt(p.size - 1) }
			for (index in p.indices) p[index] = nextInclusionProbability(p[index], observed, target)
			val events = ArrayList<Any?>()
			for (index in p.indices) if (rng() < p[index]) events.add(mapOf("p" to p[index], "at" to System.currentTimeMillis().toDouble()))
			observed = events.size
			eventCounts.add(observed)
			estimates.add(estimatePopulation(events).estimate)
		}
		return estimates to eventCounts
	}

	private fun mean(values: List<Double>): Double = values.sum() / values.size

	@Test
	fun `HT estimate matches known populations`() {
		for (m in listOf(20, 200, 2000)) {
			val p = CENSUS_TARGET_EVENTS.toDouble() / m
			val events = (0 until CENSUS_TARGET_EVENTS).map { mapOf<String, Any?>("p" to p, "at" to (System.currentTimeMillis() - it).toDouble()) }
			val estimate = estimatePopulation(events)
			assertEquals(m.toDouble(), estimate.estimate, 1e-9)
			assertEquals(CENSUS_TARGET_EVENTS, estimate.sampleSize)
		}
	}

	@Test
	fun `estimatePopulation ignores invalid p values`() {
		val now = System.currentTimeMillis().toDouble()
		val events = listOf<Any?>(
			mapOf("p" to 0.1, "at" to now),
			mapOf("p" to 0.0, "at" to now),
			mapOf("p" to 2.0, "at" to now),
			mapOf("p" to "x", "at" to now),
			mapOf("p" to null, "at" to now),
		)
		val estimate = estimatePopulation(events)
		assertEquals(10.0, estimate.estimate, 1e-9)
		assertEquals(1, estimate.sampleSize)
	}

	@Test
	fun `200 node feedback loop event count regresses to target while estimate stays`() {
		val m = 200
		val t = CENSUS_TARGET_EVENTS
		for (seed in listOf(0x1, 0xC0FFEE, 0xF00D, 0xABCD)) {
			val rng = makeRng(seed)
			val p = ArrayList<Double>()
			repeat(m) { p.add(0.5) }
			var observed = 0
			val rounds = ArrayList<Int>()
			val estimates = ArrayList<Double>()
			for (round in 0 until 15) {
				for (index in p.indices) p[index] = nextInclusionProbability(p[index], observed, t)
				val events = ArrayList<Any?>()
				for (index in p.indices) if (rng() < p[index]) events.add(mapOf("p" to p[index], "at" to System.currentTimeMillis().toDouble()))
				observed = events.size
				rounds.add(observed)
				estimates.add(estimatePopulation(events).estimate)
			}
			assertTrue("seed $seed first-round events ${rounds[0]}", rounds[0] >= 80)
			val laterRounds = rounds.drop(1).map { it.toDouble() }
			val laterEstimates = estimates.drop(1)
			assertTrue("seed $seed mean later events ${mean(laterRounds)}", mean(laterRounds) >= 12 && mean(laterRounds) <= 30)
			assertTrue("seed $seed mean later estimate ${mean(laterEstimates)}", mean(laterEstimates) >= 170 && mean(laterEstimates) <= 230)
			assertTrue("seed $seed first-round estimate ${estimates[0]}", estimates[0] >= 170 && estimates[0] <= 230)
		}
	}

	@Test
	fun `multiplicative update converges event count toward target`() {
		var p = 0.5
		val m = 200
		val observed = ArrayList<Int>()
		for (round in 0 until 200) {
			observed.add(Math.round(m * p).toInt())
			p = nextInclusionProbability(p, observed.last(), CENSUS_TARGET_EVENTS)
		}
		val last = observed.last()
		assertTrue("last event count $last", last >= 15 && last <= 25)
	}

	@Test
	fun `E equals 0 grows probability up to 1`() {
		assertEquals(0.1 * CENSUS_GROW_FACTOR, nextInclusionProbability(0.1, 0, CENSUS_TARGET_EVENTS), 1e-12)
		assertEquals(1.0, nextInclusionProbability(1, 0, CENSUS_TARGET_EVENTS), 1e-12)
	}

	@Test
	fun `update clamps into minP to 1`() {
		assertEquals(CENSUS_MIN_P, nextInclusionProbability(0.5, 100_000, CENSUS_TARGET_EVENTS), 1e-12)
		assertEquals(1.0, nextInclusionProbability(0.5, 1, CENSUS_TARGET_EVENTS), 1e-12)
		assertEquals(CENSUS_MIN_P * 4, nextInclusionProbability(Double.NaN, 5, CENSUS_TARGET_EVENTS), 1e-12)
	}

	@Test
	fun `clampP handles invalid input`() {
		assertEquals(CENSUS_MIN_P, clampP(-1), 1e-12)
		assertEquals(1.0, clampP(1.5), 1e-12)
		assertEquals(CENSUS_MIN_P, clampP(Double.NaN), 1e-12)
		assertEquals(CENSUS_MIN_P, clampP(null), 1e-12)
	}

	@Test
	fun `census estimate tracks population through gradual join and churn`() {
		val timeline: (Int) -> Int = { round ->
			when {
				round < 6 -> 300
				round < 16 -> 0
				round < 21 -> -200
				else -> 0
			}
		}
		val joinedMeans = ArrayList<Double>()
		val churnedMeans = ArrayList<Double>()
		for (seed in 1..100) {
			val (estimates, _) = simulateCensus(seed, 200, timeline, 31)
			joinedMeans.add(mean(estimates.subList(10, 16)))
			churnedMeans.add(mean(estimates.subList(26, 31)))
		}
		assertTrue("joined mean ${mean(joinedMeans)}", mean(joinedMeans) >= 1900 && mean(joinedMeans) <= 2100)
		assertTrue("churned mean ${mean(churnedMeans)}", mean(churnedMeans) >= 950 && mean(churnedMeans) <= 1050)
		assertTrue("churned mean did not drop below joined mean", mean(churnedMeans) < mean(joinedMeans))
	}
}
