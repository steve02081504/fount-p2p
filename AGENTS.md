# P2P / Federation / Entity Files Guide

## Package layers (`@steve02081504/fount-p2p`)

| Layer | Directory | Key modules |
|---|---|---|
| L0 | `core/` | `hexIds`, `entity_id_parse`, `entity_id`, `canonical_json`, `bytes_codec` |
| L1 | `crypto/`, `wire/`, `schemas/` | Cryptography, wire-protocol ingress, canonical validation |
| L2 | `node/` | `initNode`, `identity`, `entity_store`, `denylist`, `reputation_store`, `storage_plugins` |
| L3 | `discovery/`, `link/`, `transport/`, `rooms/` | Discovery, RTC links, rooms |
| L4 | `trust_graph/`, `mailbox/`, `dag/`, `federation/`, `files/`, `entity/`, `governance/`, `reputation/` | Federation, store-and-forward, DAG, EVFS, tunables |

**Outside the package (shell / frontend; p2p must not import):** Chat/Social semantics, frontend mention rendering, entity identity provisioning, etc. live in the upper shell. Standalone clients use `import { startNode } from '@steve02081504/fount-p2p'`.

**Facade:** `index.mjs`; subpath exports mirror directories (`./transport/*`, `./registries/*`, `./core/*`, … wildcard exports).

**File naming:** parent directory is scope — child `.mjs` files use short names (`mailbox/store.mjs`, `wire/ingress.mjs`, `registries/event_type.mjs`). Tunables default file is `<dir>/tunables.json`. Subpath `package.json` exports mirror filenames (`./trust_graph/resolve`, `./dag/canonicalize_row`, …).

Production import boundary: `test/integration/p2p_shell_import_guard.test.mjs`.

**Tests:** `npm test` — package pure logic (Node). `npm run test:fount` — cross-repo bridge (Deno; fount social uses `npm:`). Dev-time relative import check: `node scripts/check-imports.mjs`.

**Test assertions:** `test/helpers/assert.mjs` re-exports `assert` / `assertEquals` / `assertThrows`; import from there in `test/` and `sim/test/` instead of inlining duplicate helpers.

Fount bridge: `test/fount/` + `test/helpers/fount_paths.mjs` (`fountBridgeSkipReason`: skip if not Deno / no fount / target file missing; hard-fail on import failure). `deno.json` must set `nodeModulesDir: "none"` to avoid polluting this repo's `node_modules`.

## Trust boundaries

- **Untrusted ingress:** discovery adverts/signals, link/overlay envelopes, group WebSocket federation frames, `remoteIngest`, `part_timeline_put`/`part_invoke` — validation and `canonicalize*` happen ONLY at this boundary.
- **Trusted after disk:** once read from `events.jsonl`, only `stripDagEventLocalExtensions` runs; upper layers do NOT re-run hex canonicalization.
- **Node data:** `initNode({ nodeDir })` singleton under `nodeDir` — `node.json`, `network.json`, `denylist.json`, `reputation.json`, `mailbox/`, `chunks/`. Default `EntityStore` root is `{nodeDir}/entities/` (shell may inject a custom store).
- **Entity key chain:** `federation/entity_key_chain.mjs` — `entity_key_rotate` / `entity_key_revoke`; `state.entityKeyHistory`; revoke signature domain `ENTITY_KEY_REVOKE_DOMAIN` (`fount-entity-key-revoke`).
- **TrustGraph fanout:** timeline/chunk exploration → `requireTrustGraphProvider().fanoutToTopNodes`; **targeted packets** (Mailbox) → `sendToNode`/User Room, never fanout.
- **Group room startup invariant:** `group_link_set.start()` / `rooms/scoped_link.start()` must call `registry.ensureRuntime()` before topic subscribe/advertise.
- **User-room startup invariant:** `ensureUserRoom()` must call `registry.ensureRuntime()` on first init.
- **Signaling & linking:** see [docs/signaling.md](docs/signaling.md).
- **Mailbox:** store-and-forward at `{nodeDir}/mailbox/store.jsonl`.
- **Manifest ACL / transfer owner:** shells register matchers; P2P core does not hard-code chat/social types.
- **Channel message encryption:** per-channel `K_ch`, wire scheme **`ckg`** (`crypto/channel.mjs`); CKG-decrypted payloads must not be trusted outside the DAG Ed25519 signature context.
- **Denylist vs personal lists:** node-level `denylist.json` vs per-entity `personal_block.json`/`personal_hide.json` (under the EntityStore entity directory).
- **Stale peer observability:** `transport/stale_peer_log.mjs` records federation/room identity-map lag; no fallback behavior, debug_logs only.
- **Group storage plugins:** `node/storage_plugins.mjs` provides local reference impl; S3/federated backends are injected by the shell.

## Subjective reputation (`reputation.json`)

- **Single global score per peer** at `{nodeDir}/reputation.json`.
- **Subjective slash:** `subjectiveSlashPenalty(claim, repSender, rep_max_eff)` — influence scales with sender trust.
- **Anti-Sybil:** `applyDecayCollusionAfterSlash` after slash/kick/ban.
- **Safe penalties:** relay bump, gossip unknown-want, message rate, chunk store/fetch, and other self-observed attributable signals.
- **Do not add:** penalizing peers that merely relay invalid events; penalizing RPC timeouts or empty responses.

## Entity files (EVFS)

- **Storage:** ciphertext chunks `{nodeDir}/chunks/` (CAS); logical manifest `{EntityStoreRoot}/{entityHash}/files/{path}.manifest.json`; default `EntityStoreRoot = {nodeDir}/entities`.
- **Core modules:** `files/`, `entity/files/` (evfs, acl), `entity/profile.mjs` (`profile.json`).

## Tunables JSON

Runtime defaults live next to the module that consumes them:

| File | Directory |
|---|---|
| `tunables.json` | `reputation/` |
| `tunables.json` | `trust_graph/` |
| `tunables.json` | `mailbox/` |
| `tunables.json` | `governance/` |
| `tunables.json` | `dag/` |

Sim harness aggregates these via `sim/tunables_bundle.mjs` (dev-only; not published).
