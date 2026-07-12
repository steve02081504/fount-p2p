import { test } from 'node:test'

import { assert, assertEquals } from '../../test/helpers/assert.mjs'
import { resolveArchiveQuorumPeerMin, resolveArchiveQuorumPeerStrictMin } from '../../trust_graph/resolve.mjs'
import { applyTunablesBundle, prepareBundleForApply } from '../apply.mjs'
import { normalizeBundle, PARAM_SPACE, randomCandidate, sanitizeArchiveQuorum } from '../space.mjs'
import { loadDefaultTunables } from '../tunables_bundle.mjs'

test('normalizeBundle keeps every PARAM_SPACE value in its semantic domain', () => {
	for (let seed = 1; seed <= 40; seed++) {
		const bundle = normalizeBundle(randomCandidate(seed))
		for (const spec of PARAM_SPACE) {
			const v = bundle[spec.module][spec.key]
			const label = `${spec.module}.${spec.key} seed ${seed}`
			assertEquals(Number.isFinite(v), true, label)
			if (spec.kind === 'count') assertEquals(Number.isInteger(v) && v >= 1, true, label)
			if (spec.kind === 'pos') assertEquals(v > 0, true, label)
			if (spec.kind === 'unit') assertEquals(v > 0 && v < 1, true, label)
			if (spec.kind === 'score') assertEquals(v > -1 && v < 1, true, label)
		}
	}
})

test('prepareBundleForApply preserves fractional tunables', () => {
	const bundle = randomCandidate(7)
	bundle.reputation.penaltyUnknownWant = 0.22
	bundle.reputation.slashDefaultClaim = 0.2
	bundle.social.socialRepHideThreshold = -0.4
	bundle.reputation.collusionDelta = 0.62

	const ready = prepareBundleForApply(bundle)
	assertEquals(ready.reputation.penaltyUnknownWant, 0.22)
	assertEquals(ready.reputation.slashDefaultClaim, 0.2)
	assertEquals(ready.social.socialRepHideThreshold, -0.4)
	assertEquals(ready.reputation.collusionDelta, 0.62)
})

test('prepareBundleForApply does not zero non-space reputation keys', () => {
	const bundle = randomCandidate(11)
	const ready = prepareBundleForApply(bundle)
	assertEquals(ready.reputation.slashDefaultClaim > 0, true)
	assertEquals(ready.reputation.slashUnverifiedDefaultClaim > 0, true)
	assertEquals(ready.reputation.chunkStoreRepBump > 0, true)
})

test('applyTunablesBundle requires socialTunablesPath', async () => {
	await assert.rejects(
		() => applyTunablesBundle(loadDefaultTunables(), {}),
		/socialTunablesPath required/u,
	)
})

test('prepareBundleForApply enforces strict>=base quorum rule', () => {
	const bundle = randomCandidate(3)
	bundle.archive.archiveQuorumPeerMinRatio = 0.8
	bundle.archive.archiveQuorumPeerStrictMinRatio = 0.1
	sanitizeArchiveQuorum(bundle)
	const refN = 8
	assertEquals(
		resolveArchiveQuorumPeerStrictMin(refN, bundle.archive)
		>= resolveArchiveQuorumPeerMin(refN, bundle.archive),
		true,
	)
})
