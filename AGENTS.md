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

**Facade:** `index.mjs`; subpath exports mirror directories.

Detail docs: [transports](docs/transports.md) · [mesh](docs/mesh.md) · [signaling](docs/signaling.md) · [nostr-relay-discovery](docs/nostr_relay_discovery.md) · [runtime](docs/runtime.md) · [infra](docs/infra.md) · [wire](docs/wire.md) · [evfs](docs/evfs.md) · [reputation](docs/reputation.md)

### Runtime: isomorphic vs Node

| Surface | Runtime | Notes |
|---|---|---|
| `core/*` | Node + browser | No `node:*` builtins |
| `crypto/crypto.mjs` | Node + browser | `@noble/hashes` + `@noble/curves` only — never `node:crypto` |
| `crypto/key.mjs` / `crypto/channel.mjs`, disk I/O, LAN/BT, `ws`, CLI / `startNode` | Node (+ Deno bridge) | Do not load the whole package via esm.sh in the browser |

Deno / native / BT: [runtime.md](docs/runtime.md).

## Conventions

- Prefer shared helpers under `utils/`, `core/`, `wire/subscribe`, `wire/adapter` — do not reimplement LRU/TTL/inflight/atomic-fs/shuffle.
- **No pure-forward aliases:** do not add `fooText`/`fooAlias` that only `return foo(sameArgs)` when the callee already accepts those types (e.g. never wrap `sha256Hex` as `sha256TextHex`). Domain names must add logic or type narrowing, not just rename.
- **Heterogeneous backends:** normalize at the load boundary (e.g. `link/rtc/ice_local_hostname.mjs` wraps W3C RTC backends); call sites speak one contract.
- **File naming:** parent directory is scope — short child names. Tunables default `<dir>/tunables.json` (exception: `schemas/part_query.tunables.json`). Subpath `package.json` exports mirror filenames.
- **Import boundary:** `test/integration/p2p_shell_import_guard.test.mjs`.
- **No scattered `trim` / `toLowerCase`:** hex IDs must already be lowercase and without a `0x` prefix — a `0x`-prefixed, mixed-case, or whitespace value is rejected by `isHex64`/`isEntityHash128`, never cleaned. Exceptions: JSONL blank lines, SDP fingerprint, CLI/`scripts` parsing.
- **No `String(x)` / `x || ''` on typed `string`:** if `@param {string}`, use it directly; `String(...)` / `|| ''` / `?? ''` only at optional / `unknown` / disk / inbound boundaries, or number→string.
- **Optional methods:** `if (fn) return await fn(...)` / `if (fn) …` — never `typeof x === 'function'`.

## Tests / tools

- `npm test` — pure + integration + frontend (Node; `--test-force-exit`)
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

- **Untrusted ingress only:** discovery adverts/signals, link/overlay envelopes, group federation frames, `remoteIngest`, `part_timeline_*` / `part_invoke`, `part_query_*`, manifest fetch responses (`fed_manifest_data`). Validate / `canonicalize*` / `verifySignedPublicManifest` **only** here. Non-public `fed_manifest_data` is accepted only into an `allowNonPublic` pending slot (targeted fanout) and passes `normalizeFileManifest` + owner/path match — the serving node's servicer is the authorization gate. [evfs.md](docs/evfs.md)
- **Trusted after disk:** from `events.jsonl`, only `stripDagEventLocalExtensions` — no re-canonicalization upstream.
- **Fanout vs targeted / timed collect:** [wire.md](docs/wire.md).
- **Channel encryption:** per-channel `K_ch`, scheme `channel-key` (`CHANNEL_KEY_SCHEME`); decrypted payloads are untrusted outside DAG Ed25519 context.
- **Denylist vs personal lists:** node `denylist.json` vs per-entity `personal_block.json` / `personal_hide.json`.
- **Manifest ACL / transfer owner / servicer:** ownership is routed by `registerManifestOwner` matchers only; ACL & servicer handlers are keyed by `ownerId` (a `type` may be reused across families but never acts as a routing key). Core does not hard-code chat/social types. Non-public manifests are served cross-node only via a registered servicer; unclaimed non-public is denied (no `type` fallback).

### Node / network

- **Node data:** `initNode({ nodeDir, entityStore? })` — `node.json`, `network.json`, `denylist.json`, `reputation.json`, `mailbox/`, `chunks/`. Default EntityStore: `{nodeDir}/entities/`. No `FOUNT_*` env knobs — subprocess IPC uses argv.
- **fount network:** shells use `startNode` / `ensureLinkToNode` / `sendToNodeLink` / rooms — never import `link/` internals or pick a transport. Providers: `registerLinkProvider` from `./link` or facade.
- **Link `level` vs discovery `priority`:** descending `level` picks data transport (`nostr` = −∞ last resort); ascending `priority` orders handshake/presence media only. [transports.md](docs/transports.md)
- **Mesh first / no versioning:** ≥N links (K acquaintances + N−K explore); discovery API is `listVisibleNodeHashes` + `connectToNode` only; no topic on the fount-network surface; no version/compat fields. [mesh.md](docs/mesh.md)
- **Room / registry:** `configureLinkRegistry(opts)` before first `getLinkRegistry`. `startNode` does not take registry options. `createGroupLinkSet` is the kernel; `createScopedLinkRoom` is a dial-all preset. Rooms call `registry.ensureRuntime()` before subscribe/advertise — [runtime.md](docs/runtime.md)
- **Fetch ≠ apply:** `ingestEncryptedAdvert` vs `noteAdvertPeerHints`; reputation pull never writes — [reputation.md](docs/reputation.md). Public-manifest cache/fanout: [evfs.md](docs/evfs.md). Node-scope attaches: [infra.md](docs/infra.md).

## Tunables JSON

| File | Directory |
|---|---|
| `tunables.json` | `transport/`, `infra/`, `reputation/`, `trust_graph/`, `mailbox/`, `governance/`, `dag/` |
| `part_query.tunables.json` | `schemas/` |

Sim harness: `sim/tunables_bundle.mjs` (dev-only). See [sim/AGENTS.md](sim/AGENTS.md).
