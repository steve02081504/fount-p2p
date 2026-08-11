# P2P / Federation / Entity Files Guide

## Package layers (`@steve02081504/fount-p2p`)

| Layer | Directory | Key modules |
|---|---|---|
| L0 | `core/` | `hexIds`, `entity_id_parse`, `entity_id`, `logical_entity`, `canonical_json`, `bytes_codec` |
| L1 | `crypto/`, `wire/`, `schemas/` | Cryptography, wire-protocol ingress, canonical validation |
| L2 | `node/` | `initNode`, `identity`, `entity_store`, `denylist`, `reputation_store`, `storage_plugins` |
| L3 | `discovery/`, `link/`, `transport/` | fount network (registry/rooms); `registerLinkProvider` via `./link` or facade |
| L4 | `trust_graph/`, `mailbox/`, `dag/`, `federation/`, `files/`, `governance/`, `reputation/` | Federation, store-and-forward, DAG, EVFS, tunables |

**Outside the package** (shell / frontend; p2p must not import): chat/social semantics, mention rendering, entity identity provisioning, etc. Standalone clients: `import { startNode } from '@steve02081504/fount-p2p'`.

**Facade:** `index.mjs`; subpath exports mirror directories. Public `./transport/*`: `link_registry`, `user_room`, `group_link_set`, `node_scope`, `room_scopes`, `remote_user_room`, `scoped_link`.

Detail docs: [transports](docs/transports.md) · [mesh](docs/mesh.md) · [signaling](docs/signaling.md) · [runtime](docs/runtime.md) · [infra](docs/infra.md) · [evfs](docs/evfs.md)

### Runtime: isomorphic vs Node

| Surface | Runtime | Notes |
|---|---|---|
| `core/*` | Node + browser | No `node:*` builtins |
| `crypto/crypto.mjs` | Node + browser | `@noble/hashes` + `@noble/curves` only — never `node:crypto` |
| `crypto/key.mjs` / `crypto/channel.mjs`, disk I/O, LAN/BT, `ws`, CLI / `startNode` | Node (+ Deno bridge) | AES-GCM / HMAC / fs / native optional; do not load the whole package via esm.sh in the browser |

Safe browser imports: `…/core/logical_entity`, `…/crypto` (`crypto/crypto.mjs`). Full-node runtime stays on Node. Deno / native / BT: [runtime.md](docs/runtime.md).

## Conventions

- **Shared helpers:** `utils/shuffle`, `utils/emit_safe`, `utils/lru.createLruMap`, `utils/ttl_map.createTtlMap` (bounded; TTL maps take `maxSize`), `utils/inflight_table.createInflightTable` (same-key reuse + touch; EVFS fanout), `utils/fetch_wait.createFetchWaitTable` (bounded pending fetch slots), `utils/atomic_fs` (unique tmp + Windows rename retries; used by `utils/json_io` and `dag/storage`), `core/bytes_codec.toBytes`, `core/object.isPlainObject`, `core/partpath.parsePartpath` (inbound shape check only — no rewrite), `core/composite_key`, `link/providers/link_id_pipe`, `wire/subscribe.subscribeWire`, `wire/adapter` (`WireAdapter` / `WireContext`).
- **Heterogeneous backends:** normalize at the load boundary (e.g. `link/rtc/w3c_bridge.mjs` EventEmitter → W3C); call sites speak one contract — no multi-API attach shims in providers / `channel_mux`.
- **File naming:** parent directory is scope — short child names (`mailbox/store.mjs`, `wire/part/query.mjs`, `federation/part_query/runtime.mjs`). Tunables default `<dir>/tunables.json` (exception: `schemas/part_query.tunables.json`). Subpath `package.json` exports mirror filenames.
- **Import boundary:** `test/integration/p2p_shell_import_guard.test.mjs`.

## Tests / tools

- `npm test` — pure + integration (Node; `--test-force-exit`)
- `npm run test:live` — live link / LAN smoke
- `npm run test:fount` — cross-repo Deno bridge (`test/fount/`, `test/helpers/fount_paths.mjs`); see [runtime.md](docs/runtime.md)
- `npm run test:sim` — tunables co-evolution (dev-only; [sim/AGENTS.md](sim/AGENTS.md))
- `node scripts/check-imports.mjs` — relative import check
- `node scripts/find-unused-exports.mjs` — dead-export scan (`--fount <path>` optional)
- Assertions: `test/helpers/assert.mjs` (`assert` / `assertEquals` / `assertThrows`)
- Fixed-seed identity: `test/helpers/identity.mjs` (also via `test/live/helpers.mjs`)
- Mock discovery: `test/helpers/mock_discovery.mjs`
- Browser/unenv crypto stub: `test/helpers/unenv_crypto_register.mjs` + `logical_entity_unenv_probe.mjs` (`test/pure/logical_entity_browser.test.mjs`)

## Hard rules

### Trust / ingress

- **Untrusted ingress only:** discovery adverts/signals, link/overlay envelopes, group federation frames, `remoteIngest`, `part_timeline_*` / `part_invoke`, `part_query_*`, public manifest (`fed_manifest_data`). Validate / `canonicalize*` / `verifySignedPublicManifest` **only** here.
- **Trusted after disk:** from `events.jsonl`, only `stripDagEventLocalExtensions` — no re-canonicalization upstream.
- **Fanout vs targeted:** timeline/chunk exploration → `fanoutToTopNodes`; Mailbox / targeted packets → `sendToNode` / User Room, never fanout. part_invoke RPC collect → `wire/part/fanout.collectPartInvokeResponses`（须已 `attachPartWire`）。
- **Channel encryption:** per-channel `K_ch`, scheme `channel-key` (`CHANNEL_KEY_SCHEME`); decrypted payloads are untrusted outside DAG Ed25519 context.
- **Denylist vs personal lists:** node `denylist.json` vs per-entity `personal_block.json` / `personal_hide.json`.
- **Manifest ACL / transfer owner:** shells register matchers; core does not hard-code chat/social types.

### Node / network

- **Node data:** `initNode({ nodeDir, entityStore? })` — `node.json`, `network.json`, `denylist.json`, `reputation.json`, `mailbox/`, `chunks/`. Default EntityStore: `{nodeDir}/entities/`. No `FOUNT_*` env knobs — subprocess IPC uses argv.
- **fount network:** shells use `startNode` / `ensureLinkToNode` / `sendToNodeLink` / rooms — never import `link/` internals or pick a transport. Providers: `registerLinkProvider` from `./link` or facade.
- **Link `level` vs discovery `priority`:** descending `level` picks data transport (`nostr` = −∞ last resort); ascending `priority` orders handshake/presence media only. [transports.md](docs/transports.md)
- **Mesh first / no versioning:** ≥N links (K acquaintances + N−K explore); discovery API is `listVisibleNodeHashes` + `connectToNode` only; no topic on the fount-network surface; no version/compat fields. [mesh.md](docs/mesh.md)
- **Room / registry:** `configureLinkRegistry(opts)` before first `getLinkRegistry`. `startNode` does not take registry options. `createGroupLinkSet` is the kernel; `createScopedLinkRoom` is a dial-all preset. Rooms call `registry.ensureRuntime()` before subscribe/advertise — [runtime.md](docs/runtime.md).
- **Fetch ≠ apply:** `ingestEncryptedAdvert` vs `noteAdvertPeerHints`; `pullReputationFromNode` never writes. Public-manifest cache/fanout: [evfs.md](docs/evfs.md).
- **BT / WebRTC / Deno:** [runtime.md](docs/runtime.md)
- **Infra / node-scope attaches:** [infra.md](docs/infra.md)

### Subjective reputation (`reputation.json`)

- One global score per peer at `{nodeDir}/reputation.json`.
- **Subjective slash:** `subjectiveSlashPenalty` — influence scales with sender trust.
- **Anti-Sybil:** `applyDecayCollusionAfterSlash` after slash/kick/ban.
- **Safe penalties:** self-observed attributable signals only.
- **Do not add:** penalties for merely relaying invalid events; RPC timeouts or empty responses.

### Entity files (EVFS)

- **Storage:** ciphertext chunks `{nodeDir}/chunks/` (CAS); manifests `{EntityStoreRoot}/{entityHash}/files/{path}.manifest.json`.
- **Modules:** `files/` — `evfs`, `evfs_ref`, `chunk/*`, `manifest/*` (normalize / public / fetch / acl / pending), `fed/*` (responder / fetch_shared). Part query runtime: `federation/part_query/*`; wire attach only in `wire/part/query.mjs`.
- **Public files / fetch semantics:** [evfs.md](docs/evfs.md). Profile/avatar semantics live in the shell.

## Tunables JSON

| File | Directory |
|---|---|
| `tunables.json` | `reputation/`, `trust_graph/`, `mailbox/`, `governance/`, `dag/` |
| `part_query.tunables.json` | `schemas/` |

Sim harness: `sim/tunables_bundle.mjs` (dev-only). See [sim/AGENTS.md](sim/AGENTS.md).
