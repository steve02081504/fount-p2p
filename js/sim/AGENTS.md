---
description: P2P tunables simulation / co-evolution harness — fidelity boundary between reused real logic and heuristic proxy environment
globs: sim/**
alwaysApply: false
---

# P2P Sim Harness Guide

In-process co-evolution of **tunables** (`*.tunables.json`) against an **attack genome**, scored by `metrics.mjs`. Search proxy — **not** wire-protocol replay.

## Fidelity boundary

- **Reused verbatim** (import real decision functions; do not re-model): `reputation/engine.mjs`, `reputation/math.mjs`, `sim/social_reputation.mjs` (`*Pure`), `trust_graph/engine.mjs` (`pickTop`), `trust_graph/resolve.mjs`, `governance/join_pow.mjs`.
- **Tunables source:** `tunables_bundle.mjs` loads in-package `*.tunables.json` plus `sim/reputation_social.tunables.json`. Write social tunables back via `cli.mjs mine --social-tunables PATH` (`apply.mjs`).
- **`PARAM_SPACE` ↔ defaults:** every `PARAM_SPACE` key must exist in `loadDefaultTunables()`; clear both sides when deleting a key.
- **`socialRepHideThreshold`:** hide when `score < threshold`. Default `0` (suppress negatives only). Raise the threshold to raise `falsePositiveRate` — never use a negative threshold for "stricter".
- **Heuristic proxy** (not the real path): `model.mjs`, `discovery.mjs`, `transport.mjs`, `integrity.mjs` — analytical "params → defense" only.
- **Mesh-first:** explore slots and cold-start join are mandatory; fanout/trust stay separate from link presence. Policy: [docs/mesh.md](../docs/mesh.md). Wiring: [cold_start.md](cold_start.md).

## Anti-drift

- Do not hand-copy runtime constants. RTC budget from `transport/rtc_connection_budget.mjs`. `EXPLORE_MAX_PER_SOURCE` mirrors `peer_pool.mjs` but stays local (importing `peer_pool` pulls fs) — `test/fidelity.test.mjs` asserts equality.
- Signaling source names (`DEFAULT_SIGNALING_SOURCES`) must be real provider ids (`lan` / `nostr` / `bt`). No `tracker` provider.
- New sim constants that shadow real ones need a matching assertion in `fidelity.test.mjs`.

## Determinism

- Seeded via `rng.mjs` (`createRng`). `runSimulation(...)` must be pure — `fidelity.test.mjs` asserts serial == parallel == batched snapshots. Use `simulationContext.now` (virtual clock, +60s/round); no wall-clock or unseeded RNG.
- Round state object is `simulationContext` (not `ctx`); `buildWorld` returns `{ simulationContext }`.
