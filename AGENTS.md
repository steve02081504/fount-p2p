# P2P / Federation / Entity Files Guide

## Package layers (`@steve02081504/fount-p2p`)

| Layer | Directory | Key modules |
|---|---|---|
| L0 | `core/` | `hexIds`, `entity_id_parse`, `entity_id`, `logical_entity`, `canonical_json`, `bytes_codec` |
| L1 | `crypto/`, `wire/`, `schemas/` | Cryptography, wire-protocol ingress, canonical validation |
| L2 | `node/` | `initNode`, `identity`, `entity_store`, `denylist`, `reputation_store`, `storage_plugins` |
| L3 | `discovery/`, `link/`, `transport/`, `rooms/` | fount network (registry/rooms); `registerLinkProvider` via `./link` or facade |
| L4 | `trust_graph/`, `mailbox/`, `dag/`, `federation/`, `files/`, `governance/`, `reputation/` | Federation, store-and-forward, DAG, EVFS, tunables |

**Outside the package** (shell / frontend; p2p must not import): chat/social semantics, mention rendering, entity identity provisioning, etc. Standalone clients: `import { startNode } from '@steve02081504/fount-p2p'`.

**Facade:** `index.mjs`; subpath exports mirror directories. Public `./transport/*`: `link_registry`, `user_room`, `group_link_set`, `node_scope`, `room_scopes`, `remote_user_room`. Internals and providers: [docs/transports.md](docs/transports.md). Mesh: [docs/mesh.md](docs/mesh.md). Signaling: [docs/signaling.md](docs/signaling.md). Runtime: [docs/runtime.md](docs/runtime.md). Infra / node-scope attaches: [docs/infra.md](docs/infra.md).

**Shared helpers:** `utils/shuffle`, `utils/emit_safe`, `utils/lru.createLruMap`, `utils/ttl_map.createTtlMap` (process caches must be bounded; TTL maps take `maxSize`), `core/bytes_codec.toBytes`, `link/providers/link_id_pipe`.

**File naming:** parent directory is scope — child `.mjs` files use short names (`mailbox/store.mjs`). Tunables default: `<dir>/tunables.json`. Subpath `package.json` exports mirror filenames.

**Import boundary:** `test/integration/p2p_shell_import_guard.test.mjs`.

**Tests / tools:**

- `npm test` — package pure + integration (Node; `--test-force-exit`)
- `npm run test:live` — live link / LAN smoke (Node; `--test-force-exit`)
- `npm run test:fount` — cross-repo bridge (Deno; fount social uses `npm:`)
- `npm run test:sim` — tunables co-evolution sim (dev-only)
- `node scripts/check-imports.mjs` — relative import check
- `node scripts/find-unused-exports.mjs` — dead-export scan (`--fount <path>` optional)
- Assertions: `test/helpers/assert.mjs` (`assert` / `assertEquals` / `assertThrows`) — use in `test/` and `sim/test/`
- Fixed-seed identity: `test/helpers/identity.mjs` (re-exported by `test/live/helpers.mjs`)
- Mock discovery (list+connect API): `test/helpers/mock_discovery.mjs` — register in live/integration tests; supports `publishAdvert` / `watchGroupAdverts`
- fount bridge: `test/fount/` + `test/helpers/fount_paths.mjs` (`fountBridgeSkipReason`: skip if not Deno / no fount / missing target; hard-fail on import failure). `deno.json` must set `nodeModulesDir: "none"`.

## Trust boundaries

- **Untrusted ingress:** discovery adverts/signals, link/overlay envelopes, group federation frames, `remoteIngest`, `part_timeline_*` / `part_invoke`, `part_query_*`, public manifest (`fed_manifest_data`). Validate / `canonicalize*` / `verifySignedPublicManifest` **only** here.
- **Trusted after disk:** from `events.jsonl`, only `stripDagEventLocalExtensions`; no re-canonicalization upstream.
- **Node data:** `initNode({ nodeDir, entityStore? })` — `node.json`, `network.json`, `denylist.json`, `reputation.json`, `mailbox/`, `chunks/`. Default EntityStore: `{nodeDir}/entities/` (shell may inject). Logger/signaling: `setNodeLogger` / `setSignalingRuntimeConfig` (relay change → `reloadDiscoveryRelays`). Connectivity diagnostics: `setConnectivityDebug(true)` (`node/log.mjs` → Nostr/LAN/BT/mesh/dial); CLI enables unless `--quiet`. No `FOUNT_*` env knobs — subprocess IPC uses argv (e.g. BT probe timeout), not env.
- **Fanout vs targeted:** timeline/chunk exploration → `fanoutToTopNodes`; Mailbox / targeted packets → `sendToNode` / User Room, never fanout.
- **part_query:** multi-hop opaque query (`wire/part_query.mjs`); shell registers `registerQueryInboundHandler`; initiator `queryNetwork(...)`; responses reverse-path for relay cache (`wire/part_query_cache.mjs`).
- **Room startup:** `group_link_set.start()` / `scoped_link.start()` / first `ensureUserRoom()` must call `registry.ensureRuntime()` before subscribe/advertise. `ensureRuntime` does not await listen/relays/BT — see [docs/runtime.md](docs/runtime.md).
- **fount network:** shells use `startNode` / `ensureLinkToNode` / `sendToNodeLink` / rooms — never import `link/` internals or pick a transport. Provider registration: `registerLinkProvider` from `./link` or facade.
- **Mesh first / no versioning:** keep ≥N links (K acquaintances + N−K explore); discovery API is `listVisibleNodeHashes` + `connectToNode` only; no topic on the fount-network surface; no version/compat fields. Details: [docs/mesh.md](docs/mesh.md), [docs/transports.md](docs/transports.md).
- **Infra / node-scope wires:** optional public-good relay via `startInfra` / `stopInfra`; composable attaches are refcount-shared. Details: [docs/infra.md](docs/infra.md).
- **Link registry:** `configureLinkRegistry(opts)` before first `getLinkRegistry`; runtime `setMaxActive` / `setIceServers` / `ensureOverlayRouter` / `reloadDiscoveryRelays`. `startNode` does not take registry options.
- **Routing profile:** `setRoutingProfile('default'|'low')`.
- **Rooms:** `createGroupLinkSet` is the kernel (`start` + autoconnect); `createScopedLinkRoom` is a thin dial-all preset.
- **Fetch ≠ apply:** `ingestSignedAdvert` vs `applyAdvertPeerHints`; `fetchPublicManifest` defaults to no cache (`cache: true` or `cachePublicManifest`); `pullReputationFromNode` never writes.
- **Entity key chain:** `federation/entity_key_chain.mjs` — rotate/revoke.
- **Bluetooth:** optionalDependencies `@stoprocent/noble` / `@stoprocent/bleno`. Hardware probe is subprocess-only; never `waitPoweredOn` in the parent. See [docs/runtime.md](docs/runtime.md).
- **Mailbox:** `{nodeDir}/mailbox/store.jsonl`.
- **Manifest ACL / transfer owner:** shells register matchers; core does not hard-code chat/social types.
- **Channel encryption:** per-channel `K_ch`, scheme `ckg` (`crypto/channel.mjs`); decrypted payloads are untrusted outside DAG Ed25519 context.
- **Denylist vs personal lists:** node `denylist.json` vs per-entity `personal_block.json` / `personal_hide.json`.
- **Group storage plugins:** `node/storage_plugins.mjs` is the local reference; S3/federated backends are shell-injected.

## Subjective reputation (`reputation.json`)

- One global score per peer at `{nodeDir}/reputation.json`.
- **Subjective slash:** `subjectiveSlashPenalty(claim, repSender, rep_max_eff)` — influence scales with sender trust.
- **Anti-Sybil:** `applyDecayCollusionAfterSlash` after slash/kick/ban.
- **Safe penalties:** self-observed attributable signals (relay bump, gossip unknown-want, message rate, chunk store/fetch, …).
- **Do not add:** penalties for merely relaying invalid events; RPC timeouts or empty responses.

## Entity files (EVFS)

- **Storage:** ciphertext chunks `{nodeDir}/chunks/` (CAS); manifests `{EntityStoreRoot}/{entityHash}/files/{path}.manifest.json`.
- **Modules:** `files/` — `evfs`, `evfs_ref`, `acl`, `manifest_acl_registry`, `public_manifest` / `manifest_fetch`.
- **Public files:** `publishPublicFile` signs with recovery key; remote path `fed_manifest_get` → verify → cache. Signature covers content fields only — after verify, drop incoming `meta` except `publicSig`. Profile/avatar semantics live in the shell.

## Tunables JSON

Runtime defaults live next to the consuming module:

| File | Directory |
|---|---|
| `tunables.json` | `reputation/`, `trust_graph/`, `mailbox/`, `governance/`, `dag/` |
| `part_query.tunables.json` | `wire/` |

Sim harness aggregates via `sim/tunables_bundle.mjs` (dev-only; not published). See [sim/AGENTS.md](sim/AGENTS.md).
