#!/usr/bin/env node

import { on_shutdown } from 'on-shutdown'

import { ensureNodeDefaults, getNodeHash } from '../node/identity.mjs'
import { initNode, setNodeLogger } from '../node/instance.mjs'
import { setConnectivityDebug } from '../node/log.mjs'
import { getLinkRegistry } from '../transport/link_registry.mjs'

import { resolveNodeDir } from './default_node_dir.mjs'
import { setInfraPriority, startInfra, stopInfra } from './service.mjs'

/**
 * @param {string[]} argv - 命令行参数（不含 node 路径）
 * @returns {{ nodeDir?: string, quiet?: boolean, useLocalReputation?: boolean, help?: boolean }} 解析结果
 */
function parseArgs(argv) {
	/** @type {ReturnType<typeof parseArgs>} */
	const out = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--help' || arg === '-h') out.help = true
		else if (arg === '--quiet') out.quiet = true
		else if (arg === '--use-local-reputation') out.useLocalReputation = true
		else if (arg === '--node-dir') out.nodeDir = argv[++i]
	}
	return out
}

/** 打印 CLI 用法。 */
function printHelp() {
	console.log(`Usage: fount-p2p [--node-dir PATH] [--use-local-reputation] [--quiet]

Public-good infra relay node (overlay + mailbox).
Connectivity debug logs on by default (Nostr/LAN/mesh/dial); --quiet silences.
Non-CLI shells: setConnectivityDebug(true).
Default data dir: Windows %LOCALAPPDATA%/fount-p2p/node, else ~/.local/share/fount-p2p/node`)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
	printHelp()
	process.exit(0)
}

const nodeDir = resolveNodeDir(args.nodeDir)
initNode({ nodeDir })
if (args.quiet) {
	setNodeLogger(null)
	setConnectivityDebug(false)
}
else
	setConnectivityDebug(true)
ensureNodeDefaults()
const nodeHash = getNodeHash()
await getLinkRegistry().ensureRuntime()
if (args.useLocalReputation) setInfraPriority({ useLocalReputation: true })
await startInfra({ logger: args.quiet ? null : console })

console.log(`p2p infra running (nodeDir=${nodeDir} nodeHash=${nodeHash})`)

on_shutdown(stopInfra)
