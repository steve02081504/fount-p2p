# @steve02081504/fount-p2p

fount federation P2P layer: node identity, link handshake, TrustGraph, Mailbox store-and-forward, DAG timeline, EVFS entity files.

## Used by

- [fount](https://github.com/steve02081504/fount)
- [subfount](https://github.com/steve02081504/subfount)

## Install

```bash
npm install @steve02081504/fount-p2p
```

Requires **Node.js ≥ 20** (ESM + `import ... with { type: 'json' }`).

## Quick start

```javascript
import {
 startNode,
 ensureUserRoom,
 attachUserRoomDefaultWires,
 createScopedLinkRoom,
} from '@steve02081504/fount-p2p'

await startNode({ nodeDir: '/path/to/p2p/node' })
await ensureUserRoom() // slot + runtime only
attachUserRoomDefaultWires({ replicaUsername: 'alice' }) // full business wires
```

Shells talk to the **fount network** (`ensureLinkToNode` / `sendToNodeLink` / rooms). Do not import `link/providers/*` or choose WebRTC / BLE / LAN yourself. Provider registration: `registerLinkProvider` from `@steve02081504/fount-p2p/link` or the facade.

Public transport subpaths: `link_registry`, `user_room`, `group_link_set`, `node_scope`, `room_scopes`, `remote_user_room`. Other `transport/*` modules are internal.

## Infra relay (optional)

Public-good overlay + mailbox only — does **not** attach `rep_sync` or full user-room wires:

```bash
npx @steve02081504/fount-p2p
```

Default `nodeDir`: Windows `%LOCALAPPDATA%/fount-p2p/node`; elsewhere `~/.local/share/fount-p2p/node`.

```javascript
import { initNode, startNode, startInfra, stopInfra, setInfraPriority } from '@steve02081504/fount-p2p'

initNode({ nodeDir })
await startNode()
await startInfra({ maxActive: 64 }) // logger defaults to console; pass null to silence
setInfraPriority({ useLocalReputation: true }) // optional; reads local reputation.json only
await stopInfra()
```

Reputation pull/apply is separate: `pullReputationFromNode` → JSON; `setReputationTable` writes. See [docs/infra.md](./docs/infra.md).

## Layout

| Layer | Directory | Role |
|---|---|---|
| L0 | `core/` | Pure primitives: `hexIds`, `entity_id*`, `canonical_json` |
| L1 | `crypto/`, `wire/`, `schemas/` | Cryptography, wire protocol, canonical validation |
| L2 | `node/` | Node runtime: `identity`, `entity_store`, `denylist`, `reputation_store` |
| L3 | `discovery/`, `link/`, `transport/`, `rooms/` | Discovery + fount-network registry/rooms (`./link` = provider registration only) |
| L4 | `trust_graph/`, `mailbox/`, `dag/`, `federation/`, `files/`, `governance/`, `reputation/` | Federation, store-and-forward, DAG, EVFS, tunables |
| — | `infra/` | Optional public-good relay (`startInfra` / CLI) |
| — | `registries/` | Pluggable registries (event type, part path, room provider, …) |

Facade entry: `index.mjs` (`startNode`, `createGroupLinkSet`, `registerDiscoveryProvider`, …).

**Public transport modules:**

| Module | Role |
|---|---|
| `link_registry.mjs` | fount-network facade: dial fallback, scope/overlay |
| `user_room.mjs` / `group_link_set.mjs` / `node_scope.mjs` | rooms + composable node-scope wires |
| `room_scopes.mjs` / `remote_user_room.mjs` | scope constants / remote user slot |

`runtime_bootstrap`, `offer_answer`, `advert_ingest` are **internal** (transport). Signal crypto / rendezvous live under `discovery/internal/signal_crypto.mjs` (used by `nostr.mjs` / `adverts.mjs`; not a package export). `ensureRuntime` returns after registration and scheduling warm-up; it does not await lan_tcp listen, public relays, or Bluetooth. `setSignalingRuntimeConfig` → `reloadDiscoveryRelays`. See [docs/runtime.md](./docs/runtime.md) and [docs/transports.md](./docs/transports.md).

Root contains only the facade and package metadata; all modules live in layered subdirectories.

## Tests

```bash
npm test              # package pure + integration (Node)
npm run test:fount    # cross-repo bridge (Deno; requires fount on PATH)
npm run test:live     # link / LAN / glare smoke
npm run test:sim      # tunables co-evolution sim (dev only, not published; --social-tunables to write back)
```

During development: `node scripts/check-imports.mjs` validates relative imports. After a layout migration, `node scripts/cleanup-root-duplicates.mjs` removes stale root-level stubs.

Maintainer notes for agents / contributors: [AGENTS.md](./AGENTS.md). Sim harness fidelity: [sim/AGENTS.md](./sim/AGENTS.md).

## Optional dependencies

- `@stoprocent/noble` / `@stoprocent/bleno` — Bluetooth (optionalDependencies). Hardware probe is subprocess-only; see [docs/runtime.md](./docs/runtime.md).
- `node-datachannel` — WebRTC DataChannels (dependency).
- `ws` — Nostr discovery/signaling WebSockets (dependency).

Group chunk remote storage (S3, etc.) is implemented by the shell as `GroupStoragePlugin` and injected; see `node/storage_plugins.mjs` for the local reference implementation.

## Docs

- Mesh keep-alive / bootstrap (N/K, mesh-first): [`docs/mesh.md`](./docs/mesh.md)
- Transports and provider fallback: [`docs/transports.md`](./docs/transports.md)
- Signaling and WebRTC glare: [`docs/signaling.md`](./docs/signaling.md)
- Runtime bootstrap / BT probe: [`docs/runtime.md`](./docs/runtime.md)
- Infra relay / node-scope attaches: [`docs/infra.md`](./docs/infra.md)
