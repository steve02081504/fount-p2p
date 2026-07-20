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
import { startNode, createScopedLinkRoom, ensureUserRoom } from '@steve02081504/fount-p2p'

await startNode({ nodeDir: '/path/to/p2p/node' })
await ensureUserRoom()
```

Shells talk to the **fount network** (`ensureLinkToNode` / `sendToNodeLink` / rooms). Do not import `link/` or choose WebRTC / BLE / LAN yourself.

Subpath exports mirror source directories, e.g. `@steve02081504/fount-p2p/dag`, `@steve02081504/fount-p2p/transport/link_registry`, `@steve02081504/fount-p2p/transport/signal_crypto`, `@steve02081504/fount-p2p/registries/event_type`.

## Layout

| Layer | Directory | Role |
|---|---|---|
| L0 | `core/` | Pure primitives: `hexIds`, `entity_id*`, `canonical_json` |
| L1 | `crypto/`, `wire/`, `schemas/` | Cryptography, wire protocol, canonical validation |
| L2 | `node/` | Node runtime: `identity`, `entity_store`, `denylist`, `reputation_store` |
| L3 | `discovery/`, `link/`, `transport/`, `rooms/` | Discovery + fount-network registry/rooms (`link/providers` are package-private) |
| L4 | `trust_graph/`, `mailbox/`, `dag/`, `federation/`, `files/`, `governance/`, `reputation/` | Federation, store-and-forward, DAG, EVFS, tunables |
| — | `registries/` | Pluggable registries (event type, part path, room provider, …) |

Facade entry: `index.mjs` (`startNode`, `createGroupLinkSet`, `registerDiscoveryProvider`, …).

**Transport modules** (exported under `./transport/*`):

| Module | Role |
|---|---|
| `link_registry.mjs` | fount-network facade: dial fallback, scope/overlay |
| `runtime_bootstrap.mjs` | Progressive `ensureRuntime` (register + background listen / discovery / BT) |
| `offer_answer.mjs` | Discovery-signal glare for offer/answer providers |
| `signal_crypto.mjs` | Rendezvous topics + AES-GCM signal packets |

`ensureRuntime` returns after registration and scheduling warm-up; it does not await lan_tcp listen, public relays, or Bluetooth. See [docs/runtime.md](./docs/runtime.md) and [docs/transports.md](./docs/transports.md).

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

- Transports and provider fallback: [`docs/transports.md`](./docs/transports.md)
- Signaling and WebRTC glare: [`docs/signaling.md`](./docs/signaling.md)
