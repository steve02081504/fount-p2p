# Infra relay & node-scope attaches

Optional public-good overlay + mailbox. Day-to-day rules: [AGENTS.md](../AGENTS.md).

## `startInfra` / `stopInfra`

Call after `initNode`. CLI: `npx @steve02081504/fount-p2p`.

- **Connectivity debug:** CLI enables by default (prints `nodeHash`, Nostr/LAN/mesh/dial). `--quiet` off. Non-CLI: `setConnectivityDebug(true)`.
- **Priority:** `setInfraPriority({ useLocalReputation })` reads local `reputation.json` only (weight fn re-reads the table each call). `stopInfra` resets priority config so the next start does not inherit a ghost weight.
- **Reputation pull/export is separate:** `pullReputationFromNode` → JSON; `setReputationTable` to apply. Infra does **not** attach `rep_sync`. Donor must `attachReputationSyncWire()` (+ export allowlist); pull side auto-attaches.
- **`lockReputationMax` / `unlockReputationMax`:** unlock restores the pre-lock score.
- **`stopInfra` scope:** releases only its own attach refs, restores `maxActive`, clears rate/debug/priority weight.

## Node-scope attaches

Composable attaches in `transport/node_scope.mjs`:

- `ensureNodeScope`
- `attachNodeScopeMailbox` / `Part` / `PartQuery` / `Chunks`
- `attachUserRoomDefaultWires`

Each attach returns `dispose` and is **refcount-shared** (infra + default wires can both hold mailbox without double handlers).

- `ensureUserRoom` is **slot + runtime only** (default `attachDefaultWires: false`).
- Full preset: `attachUserRoomDefaultWires()` or `ensureUserRoom({ attachDefaultWires: true })`.
