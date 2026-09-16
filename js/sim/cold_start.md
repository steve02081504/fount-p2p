# Sim cold-start (K = 0)

Mesh policy: [docs/mesh.md](../docs/mesh.md). Day-to-day sim rules: [AGENTS.md](AGENTS.md).

When the observer has no acquaintances (`trustedPeers=[]`), the sim must still join via discovery explore slots — not idle.

| Knob | Behavior |
| --- | --- |
| `scenario.coldStartObserver: true` | Observer starts with `trustedPeers=[]` |
| `initObserverDiscovery(..., coldBootstrap=true)` | Discovery starts empty |
| Each round: `coldStartDiscoveryJoin` | Simulates mesh scan / join |

Scenario + regression: `cold_start` in `scenarios.mjs`, `sim/test/cold_start.test.mjs`.
