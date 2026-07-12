import { test } from 'node:test'

import {
	clearEventTypeRegistry,
	getGovernanceAuthzTypes,
	getPermissionAnchorTypes,
	mergedEventTypeDefs,
	registerEventTypeDefs,
	typesWithFlag,
	unregisterEventTypeDefs,
} from '../../registries/event_type.mjs'
import { assertEquals } from '../helpers/assert.mjs'



test('mergedEventTypeDefs merges owners with later owner overriding', () => {
	clearEventTypeRegistry()
	registerEventTypeDefs('a', {
		message: { gcExclude: true },
		slash: { governance: true },
	})
	registerEventTypeDefs('b', {
		message: { permissionAnchor: true },
	})
	try {
		assertEquals(mergedEventTypeDefs(), {
			message: { permissionAnchor: true },
			slash: { governance: true },
		})
	}
	finally {
		clearEventTypeRegistry()
	}
})

test('typesWithFlag aggregates flags across merged defs', () => {
	clearEventTypeRegistry()
	registerEventTypeDefs('a', {
		slash: { governance: true },
		invite: { permissionAnchor: true },
	})
	try {
		assertEquals([...getGovernanceAuthzTypes()], ['slash'])
		assertEquals([...getPermissionAnchorTypes()], ['invite'])
		assertEquals([...typesWithFlag('gcExclude')], [])
	}
	finally {
		clearEventTypeRegistry()
	}
})

test('unregisterEventTypeDefs removes owner defs', () => {
	clearEventTypeRegistry()
	registerEventTypeDefs('a', { message: { gcExclude: true } })
	unregisterEventTypeDefs('a')
	assertEquals(mergedEventTypeDefs(), {})
})
