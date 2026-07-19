---
description: P2P tunables simulation / co-evolution harness — fidelity boundary between reused real logic and heuristic proxy environment
globs: sim/**
alwaysApply: false
---

# P2P Sim Harness Guide

In-process co-evolution of **tunables** (`*.tunables.json`) against an **attack genome**, scored by `metrics.mjs`. Search proxy, **not** wire-protocol replay.

## Fidelity boundary

- **Reused verbatim** (import real decision functions; do not re-model):
  - Reputation: `reputation/engine.mjs`, `reputation/math.mjs`, `sim/social_reputation.mjs` (`*Pure`)
  - Trust graph: `pickTop` (`trust_graph/engine.mjs`)
  - Tunables resolve: `resolveMailboxRelayFanout` / `resolveMailboxWantFanout` / `resolveArchiveQuorumPeerMin` / `resolveArchiveQuorumPeerStrictMin` (`trust_graph/resolve.mjs`)
  - Admission PoW: `expectedJoinPowHashes` / `powVoluntaryBonus` (`governance/join_pow.mjs`)
- **Tunables source:** `tunables_bundle.mjs` loads in-package `*.tunables.json` plus `sim/reputation_social.tunables.json`. Writing social tunables back to the shell: `--social-tunables PATH` on `cli.mjs mine` (see `apply.mjs`).
- **`PARAM_SPACE` ↔ defaults:** every `PARAM_SPACE` key must exist in `loadDefaultTunables()`; clear both sides when deleting a key.
- **`socialRepHideThreshold`:** hide when `score < threshold`. Default `0` (suppress negatives only). Raise the threshold to raise `falsePositiveRate` — never use a negative threshold for "stricter".
- **Heuristic proxy** (not the real path): `model.mjs`, `discovery.mjs`, `transport.mjs`, `integrity.mjs` — analytical "params → defense" only.

## Anti-drift

- Do not hand-copy runtime constants. RTC budget from `transport/rtc_connection_budget.mjs` (`resolveRtcBudgetLimits()` + `MAX_SOURCE_SLOT_FRACTION`). `EXPLORE_MAX_PER_SOURCE` mirrors `peer_pool.mjs` but stays local (importing `peer_pool` pulls fs into the hot path) — `test/fidelity.test.mjs` asserts equality.
- Signaling source names (`DEFAULT_SIGNALING_SOURCES`) must be real provider ids (`mdns` / `nostr` / `bt`). No `tracker` provider.
- New sim constants that shadow real ones need a matching assertion in `fidelity.test.mjs`.

## Determinism

- Seeded via `rng.mjs` (`createRng`). `runSimulation(...)` must be pure — `fidelity.test.mjs` asserts serial == parallel == batched snapshots. Use `simulationContext.now` (virtual clock, +60s/round); no wall-clock or unseeded RNG.
- Round state object is `simulationContext` (not `ctx`); `buildWorld` returns `{ simulationContext }`.
