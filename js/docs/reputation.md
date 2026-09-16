# Subjective reputation

Day-to-day package rules: [AGENTS.md](../AGENTS.md). Tunables: `reputation/tunables.json`. Sim co-evolution: [sim/AGENTS.md](../sim/AGENTS.md).

## Storage

One global score per peer at `{nodeDir}/reputation.json`.

## Slash / anti-Sybil

- **Subjective slash:** `subjectiveSlashPenalty` — influence scales with sender trust.
- **Anti-Sybil:** `applyDecayCollusionAfterSlash` after slash / kick / ban.
- **Safe penalties:** self-observed attributable signals only.

## Do not add

- Penalties for merely relaying invalid events
- Penalties for RPC timeouts or empty responses

## Fetch ≠ apply

`pullReputationFromNode` returns JSON only — never writes. Apply via `setReputationTable` (or equivalent). Infra does not attach `rep_sync` by default — see [infra.md](infra.md).
