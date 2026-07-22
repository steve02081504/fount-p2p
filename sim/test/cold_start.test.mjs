import { test } from 'node:test'

import { assert, assertEquals } from '../../test/helpers/assert.mjs'
import { coldStartDiscoveryJoin, discoveryReach } from '../discovery.mjs'
import { buildWorld, runSimulation } from '../model.mjs'
import { createRng } from '../rng.mjs'
import { resolveScenarios } from '../scenarios.mjs'
import { loadDefaultTunables } from '../tunables_bundle.mjs'

test('K=0 cold observer starts isolated before mesh scan', () => {
	const tunables = loadDefaultTunables()
	const scenario = resolveScenarios('cold_start')[0]
	const { observers, simulationContext, nodes } = buildWorld(scenario, 7, tunables)
	const cold = observers.find(obs => obs.coldStart)
	assert(cold)
	const friendlyIds = nodes.filter(n => !n.newcomer && (n.kind === 'honest' || n.kind === 'relay')).map(n => n.id)
	/**
	 * @param {string} id 节点 id
	 * @returns {number} 主观声誉分
	 */
	const scoreOf = id => cold.reputation.byNodeHash[id]?.score ?? 0
	assertEquals(discoveryReach(simulationContext.discovery, cold.id, friendlyIds, scoreOf, tunables.mailbox.maxHop), 0)
})

test('coldStartDiscoveryJoin raises reach from zero', () => {
	const tunables = loadDefaultTunables()
	const scenario = resolveScenarios('cold_start')[0]
	const { observers, simulationContext, nodes } = buildWorld(scenario, 9, tunables)
	const cold = observers.find(obs => obs.coldStart)
	assert(cold)
	const friendlyIds = nodes.filter(n => !n.newcomer && (n.kind === 'honest' || n.kind === 'relay')).map(n => n.id)
	/**
	 * @param {string} id 节点 id
	 * @returns {number} 主观声誉分
	 */
	const scoreOf = id => cold.reputation.byNodeHash[id]?.score ?? 0
	const rng = createRng(99)
	for (let round = 0; round < 6; round++)
		coldStartDiscoveryJoin(simulationContext.discovery, cold.id, friendlyIds, rng)
	assert(discoveryReach(simulationContext.discovery, cold.id, friendlyIds, scoreOf, tunables.mailbox.maxHop) > 0)
})

test('cold_start scenario finishes with transport reach', () => {
	const snap = runSimulation(resolveScenarios('cold_start')[0], 42, loadDefaultTunables())
	assert(snap.transportReachRate > 0)
})
