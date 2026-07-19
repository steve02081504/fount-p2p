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

Subpath exports mirror source directories, e.g. `@steve02081504/fount-p2p/dag`, `@steve02081504/fount-p2p/transport/link_registry`, `@steve02081504/fount-p2p/registries/event_type`.

## Layout

| Layer | Directory | Role |
|---|---|---|
| L0 | `core/` | Pure primitives: `hexIds`, `entity_id*`, `canonical_json` |
| L1 | `crypto/`, `wire/`, `schemas/` | Cryptography, wire protocol, canonical validation |
| L2 | `node/` | Node runtime: `identity`, `entity_store`, `denylist`, `reputation_store` |
| L3 | `discovery/`, `link/`, `transport/`, `rooms/` | Discovery, RTC links, rooms |
| L4 | `trust_graph/`, `mailbox/`, `dag/`, `federation/`, `files/` | Federation, store-and-forward, DAG, EVFS |
| — | `registries/` | Pluggable registries (event type, part path, room provider, …) |

Facade entry: `index.mjs` (`startNode`, `createGroupLinkSet`, `registerDiscoveryProvider`, …).

Root contains only the facade and package metadata; all modules live in layered subdirectories. After a layout migration, run `node scripts/cleanup-root-duplicates.mjs` to drop stale root stubs.

## Tests

```bash
npm test              # package pure + integration (Node)
npm run test:fount    # cross-repo bridge (Deno; requires fount on PATH)
npm run test:live     # RTC / link smoke (requires node-datachannel)
npm run test:sim      # tunables co-evolution sim (dev only, not published; --social-tunables to write back)
```

During development: `node scripts/check-imports.mjs` validates relative imports. After a layout migration, `node scripts/cleanup-root-duplicates.mjs` removes stale root-level stubs.

## Optional dependencies

- `@stoprocent/noble` / `@stoprocent/bleno` — Bluetooth (optionalDependencies). Unavailable when there is no adapter, load fails, or the radio never reaches poweredOn — other discovery/link paths continue.

Group chunk remote storage (S3, etc.) is implemented by the shell as `GroupStoragePlugin` and injected; see `node/storage_plugins.mjs` for the local reference implementation.

## Docs

- Signaling and link setup: [`docs/signaling.md`](./docs/signaling.md)
