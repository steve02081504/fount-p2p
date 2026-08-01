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

**Facade:** `index.mjs`; subpath exports mirror directories. Public `./transport/*`: `link_registry`, `user_room`, `group_link_set`, `node_scope`, `room_scopes`, `remote_user_room`. Detail docs: [transports](docs/transports.md), [mesh](docs/mesh.md), [signaling](docs/signaling.md), [runtime](docs/runtime.md), [infra](docs/infra.md).

## Conventions

- **Shared helpers:** `utils/shuffle`, `utils/emit_safe`, `utils/lru.createLruMap`, `utils/ttl_map.createTtlMap` (bounded caches; TTL maps take `maxSize`), `utils/atomic_fs` (unique tmp + Windows rename retries; used by `utils/json_io` and `dag/storage`), `core/bytes_codec.toBytes`, `link/providers/link_id_pipe`.
- **File naming:** parent directory is scope — child `.mjs` files use short names (`mailbox/store.mjs`). Tunables default: `<dir>/tunables.json`. Subpath `package.json` exports mirror filenames.
- **Import boundary:** `test/integration/p2p_shell_import_guard.test.mjs`.

## Tests / tools

- `npm test` — pure + integration (Node; `--test-force-exit`)
- `npm run test:live` — live link / LAN smoke
- `npm run test:fount` — cross-repo Deno bridge (`test/fount/`, `test/helpers/fount_paths.mjs`). Deno/WebRTC/`allowScripts`: [runtime.md](docs/runtime.md)
- `npm run test:sim` — tunables co-evolution (dev-only; [sim/AGENTS.md](sim/AGENTS.md))
- `node scripts/check-imports.mjs` — relative import check
- `node scripts/find-unused-exports.mjs` — dead-export scan (`--fount <path>` optional)
- Assertions: `test/helpers/assert.mjs` (`assert` / `assertEquals` / `assertThrows`)
- Fixed-seed identity: `test/helpers/identity.mjs` (also via `test/live/helpers.mjs`)
- Mock discovery (list+connect): `test/helpers/mock_discovery.mjs`

## Hard rules

### Trust / ingress

- **Untrusted ingress only:** discovery adverts/signals, link/overlay envelopes, group federation frames, `remoteIngest`, `part_timeline_*` / `part_invoke`, `part_query_*`, public manifest (`fed_manifest_data`). Validate / `canonicalize*` / `verifySignedPublicManifest` **only** here.
- **Trusted after disk:** from `events.jsonl`, only `stripDagEventLocalExtensions` — no re-canonicalization upstream.
- **Fanout vs targeted:** timeline/chunk exploration → `fanoutToTopNodes`; Mailbox / targeted packets → `sendToNode` / User Room, never fanout.
- **Channel encryption:** per-channel `K_ch`, scheme `channel-key` (`CHANNEL_KEY_SCHEME`); decrypted payloads are untrusted outside DAG Ed25519 context.
- **Denylist vs personal lists:** node `denylist.json` vs per-entity `personal_block.json` / `personal_hide.json`.
- **Manifest ACL / transfer owner:** shells register matchers; core does not hard-code chat/social types.

### Node / network

- **Node data:** `initNode({ nodeDir, entityStore? })` — `node.json`, `network.json`, `denylist.json`, `reputation.json`, `mailbox/`, `chunks/`. Default EntityStore: `{nodeDir}/entities/`. No `FOUNT_*` env knobs — subprocess IPC uses argv.
- **fount network:** shells use `startNode` / `ensureLinkToNode` / `sendToNodeLink` / rooms — never import `link/` internals or pick a transport. Providers: `registerLinkProvider` from `./link` or facade.
- **Link `level` vs discovery `priority`:** descending `level` picks data transport (`nostr` = −∞ last resort); ascending `priority` orders handshake/presence media only. [transports.md](docs/transports.md)
- **Mesh first / no versioning:** ≥N links (K acquaintances + N−K explore); discovery API is `listVisibleNodeHashes` + `connectToNode` only; no topic on the fount-network surface; no version/compat fields. [mesh.md](docs/mesh.md)
- **Room startup:** `group_link_set` / `scoped_link` / first `ensureUserRoom()` call `registry.ensureRuntime()` before subscribe/advertise. `ensureRuntime` does not await listen/relays/BT. [runtime.md](docs/runtime.md)
- **Link registry:** `configureLinkRegistry(opts)` before first `getLinkRegistry`. `startNode` does not take registry options. Rooms: `createGroupLinkSet` is the kernel; `createScopedLinkRoom` is a dial-all preset.
- **Fetch ≠ apply:** `ingestSignedAdvert` vs `applyAdvertPeerHints`; `fetchPublicManifest` defaults to no cache (still fanout-revalidates local publicSig by `publishedAt`); `pullReputationFromNode` never writes.
- **Bluetooth:** optional noble/bleno (noble `>=2.5.9` for safe in-process probe teardown); availability probe is in-process (`loadNoble` → `waitPoweredOn` → `stop`). [runtime.md](docs/runtime.md)
- **Infra / node-scope attaches:** [infra.md](docs/infra.md)

### Subjective reputation (`reputation.json`)

- One global score per peer at `{nodeDir}/reputation.json`.
- **Subjective slash:** `subjectiveSlashPenalty` — influence scales with sender trust.
- **Anti-Sybil:** `applyDecayCollusionAfterSlash` after slash/kick/ban.
- **Safe penalties:** self-observed attributable signals only.
- **Do not add:** penalties for merely relaying invalid events; RPC timeouts or empty responses.

### Entity files (EVFS)

- **Storage:** ciphertext chunks `{nodeDir}/chunks/` (CAS); manifests `{EntityStoreRoot}/{entityHash}/files/{path}.manifest.json`.
- **Modules:** `files/` — `evfs`, `evfs_ref`, `acl`, `manifest_acl_registry`, `public_manifest` / `manifest_fetch`.
- **Public files:** `publishPublicFile` signs with recovery key; remote `fed_manifest_get` → verify → cache. `fetchPublicManifest` always fanout-revalidates (prefer newer `publishedAt`; timeout falls back to local publicSig). Signature covers content fields only — after verify, drop incoming `meta` except `publicSig`. Profile/avatar semantics live in the shell.

## Tunables JSON

| File | Directory |
|---|---|
| `tunables.json` | `reputation/`, `trust_graph/`, `mailbox/`, `governance/`, `dag/` |
| `part_query.tunables.json` | `wire/` |

Sim harness: `sim/tunables_bundle.mjs` (dev-only). See [sim/AGENTS.md](sim/AGENTS.md).
