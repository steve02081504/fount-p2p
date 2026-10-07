# Nostr Relay Discovery & Routing

Nostr is the fount-network fallback transport (`link` level −∞, discovery `priority` 100). This document covers the **relay pool**, NIP-66 discovery, health scoring, advert relay-field signing, and handshake routing. Top-level surface: [signaling.md](signaling.md) · [transports.md](transports.md) · [mesh.md](mesh.md).

Source layout (`discovery/nostr/`):

- `index.mjs` — provider (presence / signal / advert subscriptions)
- `relays.mjs` — pool, health, NIP-66 discovery, normalization, persistence
- `selection.mjs` — handshake routing, backoff, fanout
- `session.mjs` — shared relay WebSocket sessions / subscribe primitives
- `census.mjs` — population census worker (kind 30789, HT estimate)
- `census_math.mjs` — census pure functions (inclusion-probability update, HT estimator)
- `constants.mjs` — hard limits

## Three-tier sets

`relayPool` (all known) → `workingRelays` (top-`WORKING_RELAYS_COUNT` by health) → `listenRelays` (top-`LISTEN_RELAYS_COUNT` working subset used for publish/listen).

- `public`/`manual` entries are **pinned**: preferred in `working`/`listen` when eligible and never evicted by `clearStale` or pool-cap. Failed or stale pins remain in the pool for retry, but leave the working/listen sets. Pin count may exceed the nominal caps.
- `nip66`/`peer` entries are disposable: evicted when stale (`PROBE_STALE_MS`) or when the pool exceeds `POOL_CAP`.
- A relay leaves the working/listen sets when it is **not eligible**: never probed but already failed, or its latest attempt failed, or its last success is older than `PROBE_STALE_MS`. Untested bootstrap entries stay eligible for the working set; exclusion never evicts from the pool, so dead relays keep getting retried.
- A **publish** outcome is tracked separately from probes (`lastPublishSuccess`/`lastPublishFailure`): a rejected publish keeps the relay out of the working set for `PUBLISH_FAILURE_COOLDOWN_MS` (30min) even if a later connectivity probe succeeds, and a later accepted publish clears it — a relay that answers a WebSocket probe but refuses our events must not keep advertising capacity.
- The `NIP66_BOOTSTRAP_RELAYS` set is discovery-only: those URLs are `nip66` entries and are not publish/listen targets until one of our publishes is accepted (`lastPublishSuccess > 0`). Ordinary NIP-66 discoveries stay eligible for publish testing.
- Configured `relayUrls` override the automatic listen subset; adverts publish this resolved subscription set as `listenNostrRelays`.
- Fresh nodes are seeded with `DEFAULT_RELAY_URLS` (`source: 'public'`) so `listenRelays` is never empty at cold start.
- Persistent connections stay bounded by `workingRelays` (`WORKING_RELAYS_COUNT`, max 32); pins influence selection, not simultaneous connections.

## URL normalization (single ingress)

`normalizeNostrRelayUrl` (in `relays.mjs`) is the only entry for every inbound URL (NIP-66 `d` tag, manual config, peer advert):

- `wss://` to any host; `ws://` to loopback only (`localhost` / `::1` / `127.x` — local dev/tests). Private and public `ws://` are rejected outright.
- `isRelayDestinationAllowed` then gates dialling: a **trusted** relay (local config, provider registration, the NIP-66 bootstrap set, or any pinned `public`/`manual` entry) may be private; every other relay must be a public hostname whose DNS resolves entirely to public addresses. So a private `wss://` is only reachable when something pinned or configured it.
- hostname lowercased, default port removed, trailing slashes removed, non-empty path kept.
- Invalid → `null` → dropped with an audit log (`nodeDebug('invalidRelayUrl', { url, reason })`), never silently cleaned.

## Health score

```text
dead        = latest attempt failed, or the entry never succeeded   // ties count as failed
failureRate = dead ? 1 : failureCount / (successCount + failureCount)
rtt         = clamp(dead ? MAX_RTT_MS : rttMs, 1, MAX_RTT_MS)      // DEFAULT_RTT_MS when unknown, zero or invalid
score       = rtt * (1 + failureRate * FAILURE_WEIGHT)             // FAILURE_WEIGHT = 4
score      *= STALE_PENALTY                                        // ×2 if lastProbe older than PROBE_STALE_MS
```

Lower is better. A dead entry (`failureCount > 0` and either no successes or a latest failure) scores with `MAX_RTT_MS`, `failureRate = 1`, and its stale RTT discarded, so it can never outrank a live one. `recordProbeSuccess` / `recordProbeFailure` / `recordPublishResult` share the same counters; attempt timestamps advance monotonically so success/failure ordering survives same-millisecond attempts. The health score itself does not look at publish outcomes — the publish-failure cooldown above is a separate eligibility gate. Writes to `nodeDir/nostr/relays.json` are **throttled** (2s debounce).

## Persistence

`nodeDir/nostr/relays.json`:

```text
{
  "updatedAt": 1234567890,
  "nostrRelays": [{ "url", "rttMs", "successCount", "failureCount", "lastSuccess", "lastFailure", "lastProbe", "lastPublishSuccess", "lastPublishFailure", "firstSeen", "lastSeen", "source", "nips", "clearnet", "monitorCount" }],
  "peerRoutes": { "<nodeHash64>": { "listenRelays", "peerPool", "lastGoodNostrRelays", "lastSeen" } }
}
```

`peerRoutes` is a local-only cache (never shared).

## NIP-66 discovery

- Bootstrap: `NIP66_BOOTSTRAP_RELAYS` + all `public`/`manual` as fallback, parallel, 10s connect timeout; refreshed every `NIP66_REFRESH_MS` (6h).
- `REQ` kind 30166 (limit 500) + optional 10166; parse `d` (url), `n` (clearnet only), `N` (must include NIP-01 or be absent), `rtt-open/read/write`.
- **Trust layering**: same URL reported by ≥2 distinct pubkeys → `monitorCount ≥ 2`; single report is untrusted. All candidates are probed; a successful probe upserts the entry (`source: 'nip66'`, real `monitorCount`), a failed probe drops it. Probes per round are bounded (`MAX_NIP66_PROBES_PER_ROUND`).
- Discovery is non-blocking (first round deferred to the next macrotask) and cancellable (AbortSignal tears down sockets + NIP-11 fetches), so it never blocks `ensureRuntime` or shutdown.
- `setNostrRelayDiscoveryEnabledForTests(false)` / `setNip66BootstrapRelaysForTests(urls)` are test-only hooks.

## Advert relay fields & signature

`link/handshake.mjs` extends the advert signature domain: after `lanHosts`, append `\0relays:<hex>` where `<hex>` = UTF-8→hex of `{ p: pool, l: listen }` (both sorted by url, `pool` items `{url, rtt}`).

- `sanitizeAdvertRelayFields` (verify/inbound path): pool ≤ `MAX_ADVERT_RELAY_POOL` (16), rtt ∈ [0, `MAX_RTT_MS`], deduped; listen ≤ `MAX_ADVERT_LISTEN_RELAYS` (32), deduped; dropped entries logged. `buildSignedAdvert` (outbound) uses a strict variant that throws on invalid locally-supplied relay fields instead of dropping them.
- `verifySignedAdvert` now returns `{ nodeHash, relayPool, listenRelays }` (sanitized). `ingest*Advert` passes these through; consumers must use the verified values, never the raw body.
- **Any tampering with relay fields invalidates the signature** → advert rejected.

## Handshake routing (`selection.mjs`)

`handshakeTargets(nodeHash, attempt)`:

- **Round 0**: peer-claimed `listenRelays` top 4 by composite score (own health + peer rtt); else local `workingRelays` top 4. Empty working sets do not fall back to failed pins.
- **Round ≥1**: backoff `min(2000 · 2^(attempt−1), 60000)`; base on `lastGoodNostrRelays` (expanded via `expandFromHistory` ≤ 16), or weighted-random sample of `workingRelays` (weight `1/score`); round-0 core always included; fanout capped at `MAX_ROUTING_FANOUT` (64).
- Retries ≤ `MAX_ROUTING_ATTEMPTS` (4).

`routePublishEvent(toNodeHash, event, signal)`: publishes to the current round's targets in parallel via shared sessions; any `OK` records `lastGoodNostrRelays` (last 16) + success; all-fail records failures and backs off. `sendNodeSignal` uses routing; an explicit relay override (test/user pin) publishes directly.

## Census (population estimate)

`census.mjs` implements a population census over nostr (event kind 30789, `t=fount` / `x=census`, content = base64 of the signed packet). It is driven by the `features.census` switch (`setP2PFeatures`).

- Each node keeps an inclusion probability `p`; per window it publishes an Ed25519-signed packet `{ nodeHash, nodePubKey, ts, p, sig }` (message `fount-census\0ts\0nodeHash\0p`) when `rand < p`.
- The multiplier updates `p' = p·(T/E)` (T = `CENSUS_TARGET_EVENTS`, E = observed window events); E == 0 probes upward by `CENSUS_GROW_FACTOR`. `clampP` keeps `p` in `[CENSUS_MIN_P, 1]`.
- Readers estimate online nodes with the HT estimator `M̂ = Σ(1/p)` (`estimatePopulation` in `census_math.mjs`), subtract the self-event's weight (`−1/p_self`) and add exactly 1 for the self node.
- Ingress packets are untrusted: `verifyCensusPacket` canonicalizes, checks `ts` within `CENSUS_TTL_MS`, requires `p ∈ [CENSUS_MIN_P, 1]`, and verifies `nodeHash = sha256(nodePubKey)` plus the Ed25519 signature before `noteCensusEvent` stores the event (deduped by `nodeHash`).

## Config

`channels.nostr.relay` (non-empty array) **overrides** the whole relay set — published/subscribed relays come from that list, not the pool. Without it, `resolveNostrRelayUrls()` returns `getListenRelays()`.
