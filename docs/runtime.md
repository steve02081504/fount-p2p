# Runtime bootstrap & lifecycle

`ensureRuntime`, startup/shutdown budgets, and Bluetooth hardware probe. Day-to-day shell rules: [AGENTS.md](../AGENTS.md). Providers: [transports.md](transports.md). Mesh N/K: [mesh.md](mesh.md).

## `ensureRuntime` contract

Returns after registering lan / nostr / bt discovery providers and scheduling background warm — does **not** await lan_tcp listen, Nostr relays, or BT.

| Who waits | For what |
|---|---|
| Shells (`startNode` / `ensureUserRoom`) | Nothing beyond `ensureRuntime` itself — never read `lanTcpPort` or await public-signaling warm-up |
| `buildLocalAdvert` / `whenListening` | Local lan_tcp listen only |
| `ensureLinkToNode` | `whenSignalListening` (Nostr `listenNodeSignals` attached) before dial, so offer/answer does not drop the first signal |

Nostr / LAN / BT hooks are progressive. BT discovery / `ble_gatt` always warm in the background.

### Fast-listen & dial path

- Fast-listen skips providers with `caps.probe: 'native'` (webrtc/ble) — never call their `isAvailable()` on the startup path.
- Dial path: `canReach` then `isAvailable` per provider (do not `await listAvailableLinkProviders()` first).

### Regression budgets

| Check | Bound | Test |
|---|---|---|
| Cold `ensureRuntime` | ≤50ms | `test/pure/startup_budget.test.mjs` |
| Warm `ensureRuntime` | ≤5ms | same |
| init → shutdown → natural exit | ≤10s | `test/pure/shutdown_exit.test.mjs` |
| 10s warm → shutdown → exit | ≤2s | same |

Shutdown-exit tests use the production path (default public Nostr + lan). Do not use `relayOverride` / dead-relay crutches there.

## Nostr cleanup

Use the `ws` package (not global `WebSocket`). On shutdown: `close()`, then `terminate()` after `NOSTR_CLOSE_GRACE_MS` (1s) if the socket is not yet `CLOSED`.

## Bluetooth probe

`canUseBluetoothRuntime` runs hardware probe in a **subprocess** (`discovery/bt/probe_child.mjs`: load → poweredOn → stop → exit). On failure, discovery/link fall back to other paths.

Do **not** `waitPoweredOn` in the parent process: on Windows, noble can stall the event loop; in-process `stop()` can AV ([stoprocent/noble#95](https://github.com/stoprocent/noble/issues/95)).

Actual scan/GATT still uses in-process `loadNoble` / `loadBleno`. Win defaults to scan-only. Shutdown does not await BT warm; probe child and related `setTimeout`s are `unref`'d; a generation counter invalidates late side effects.
