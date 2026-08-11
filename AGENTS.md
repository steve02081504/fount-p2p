# P2P / Federation / Entity Files Guide

## Package layers (`@steve02081504/fount-p2p`)

| Layer | Directory | Role |
|---|---|---|
| L0 | `core/` | IDs, logical entity, canonical JSON, bytes |
| L1 | `crypto/`, `wire/`, `schemas/` | Crypto, wire ingress, canonical validation |
| L2 | `node/` | `initNode`, identity, entity store, denylist, reputation, storage plugins |
| L3 | `discovery/`, `link/`, `transport/` | fount network (registry/rooms); `registerLinkProvider` via `./link` or facade |
| L4 | `trust_graph/`, `mailbox/`, `dag/`, `federation/`, `files/`, `governance/`, `reputation/` | Federation, store-and-forward, DAG, EVFS, tunables |

**Outside the package** (shell / frontend; p2p must not import): chat/social semantics, mention rendering, entity identity provisioning, etc. Standalone clients: `import { startNode } from '@steve02081504/fount-p2p'`.

**Facade:** `index.mjs`; subpath exports mirror directories. Public transport surface: [transports.md](docs/transports.md).

Detail docs: [transports](docs/transports.md) · [mesh](docs/mesh.md) · [signaling](docs/signaling.md) · [runtime](docs/runtime.md) · [infra](docs/infra.md) · [wire](docs/wire.md) · [evfs](docs/evfs.md)

### Runtime: isomorphic vs Node

| Surface | Runtime | Notes |
|---|---|---|
| `core/*` | Node + browser | No `node:*` builtins |
| `crypto/crypto.mjs` | Node + browser | `@noble/hashes` + `@noble/curves` only — never `node:crypto` |
| `crypto/key.mjs` / `crypto/channel.mjs`, disk I/O, LAN/BT, `ws`, CLI / `startNode` | Node (+ Deno bridge) | Do not load the whole package via esm.sh in the browser |

Deno / native / BT details: [runtime.md](docs/runtime.md).

## Conventions

- Prefer shared helpers under `utils/`, `core/`, `wire/subscribe`, `wire/adapter` — do not reimplement LRU/TTL/inflight/atomic-fs/shuffle.
- **Heterogeneous backends:** normalize at the load boundary (e.g. `link/rtc/w3c_bridge.mjs`); call sites speak one contract.
- **File naming:** parent directory is scope — short child names. Tunables default `<dir>/tunables.json` (exception: `schemas/part_query.tunables.json`). Subpath `package.json` exports mirror filenames.
- **Import boundary:** `test/integration/p2p_shell_import_guard.test.mjs`.

## Tests / tools

- `npm test` — pure + integration (Node; `--test-force-exit`)
- `npm run test:live` — live link / LAN smoke
- `npm run test:fount` — cross-repo Deno bridge (`test/fount/`); see [runtime.md](docs/runtime.md)
- `npm run test:sim` — tunables co-evolution (dev-only; [sim/AGENTS.md](sim/AGENTS.md))
- `node scripts/check-imports.mjs` — relative import check
- `node scripts/find-unused-exports.mjs` — dead-export scan (`--fount <path>` optional)
- Assertions: `test/helpers/assert.mjs`
- Fixed-seed identity: `test/helpers/identity.mjs`
- Mock discovery: `test/helpers/mock_discovery.mjs`

## Hard rules

### Trust / ingress

- **Untrusted ingress only:** discovery adverts/signals, link/overlay envelopes, group federation frames, `remoteIngest`, `part_timeline_*` / `part_invoke`, `part_query_*`, public manifest (`fed_manifest_data`). Validate / `canonicalize*` / `verifySignedPublicManifest` **only** here.
- **Trusted after disk:** from `events.jsonl`, only `stripDagEventLocalExtensions` — no re-canonicalization upstream.
- **Fanout vs targeted:** timeline/chunk exploration → `fanoutToTopNodes`; Mailbox / targeted packets → `sendToNode` / User Room, never fanout. Wire attach inventory: [wire.md](docs/wire.md).
- **Timed collect:** APIs with `timeoutMs` (e.g. `collectPartInvokeResponses`) must register the wait first and must not `await` fanout/send on the return path — otherwise a stuck `discoverRoute` / `link.send` defeats the timeout (#13). Pattern: `beginFedFanoutFetch` / fire-and-forget fanout + `sent === 0 → finish()`.
- **Channel encryption:** per-channel `K_ch`, scheme `channel-key` (`CHANNEL_KEY_SCHEME`); decrypted payloads are untrusted outside DAG Ed25519 context.
- **Denylist vs personal lists:** node `denylist.json` vs per-entity `personal_block.json` / `personal_hide.json`.
- **Manifest ACL / transfer owner:** shells register matchers; core does not hard-code chat/social types.

### Node / network

- **Node data:** `initNode({ nodeDir, entityStore? })` — `node.json`, `network.json`, `denylist.json`, `reputation.json`, `mailbox/`, `chunks/`. Default EntityStore: `{nodeDir}/entities/`. No `FOUNT_*` env knobs — subprocess IPC uses argv.
- **fount network:** shells use `startNode` / `ensureLinkToNode` / `sendToNodeLink` / rooms — never import `link/` internals or pick a transport. Providers: `registerLinkProvider` from `./link` or facade.
- **Link `level` vs discovery `priority`:** descending `level` picks data transport (`nostr` = −∞ last resort); ascending `priority` orders handshake/presence media only. [transports.md](docs/transports.md)
- **Mesh first / no versioning:** ≥N links (K acquaintances + N−K explore); discovery API is `listVisibleNodeHashes` + `connectToNode` only; no topic on the fount-network surface; no version/compat fields. [mesh.md](docs/mesh.md)
- **Room / registry:** `configureLinkRegistry(opts)` before first `getLinkRegistry`. `startNode` does not take registry options. `createGroupLinkSet` is the kernel; `createScopedLinkRoom` is a dial-all preset. Rooms call `registry.ensureRuntime()` before subscribe/advertise — [runtime.md](docs/runtime.md)
- **Fetch ≠ apply:** `ingestEncryptedAdvert` vs `noteAdvertPeerHints`; `pullReputationFromNode` never writes. Public-manifest cache/fanout: [evfs.md](docs/evfs.md). Node-scope attaches: [infra.md](docs/infra.md).

### Subjective reputation (`reputation.json`)

- One global score per peer at `{nodeDir}/reputation.json`.
- **Subjective slash:** `subjectiveSlashPenalty` — influence scales with sender trust.
- **Anti-Sybil:** `applyDecayCollusionAfterSlash` after slash/kick/ban.
- **Safe penalties:** self-observed attributable signals only.
- **Do not add:** penalties for merely relaying invalid events; RPC timeouts or empty responses.

### Entity files (EVFS)

Ciphertext chunks CAS + per-entity manifests. Public fetch / ACL: [evfs.md](docs/evfs.md). Profile/avatar semantics live in the shell.

## Tunables JSON

| File | Directory |
|---|---|
| `tunables.json` | `reputation/`, `trust_graph/`, `mailbox/`, `governance/`, `dag/` |
| `part_query.tunables.json` | `schemas/` |

Sim harness: `sim/tunables_bundle.mjs` (dev-only). See [sim/AGENTS.md](sim/AGENTS.md).
