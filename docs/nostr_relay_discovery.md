# Nostr Relay Discovery & Routing

Nostr is the fount-network fallback transport (`link` level −∞, discovery `priority` 100). This document covers the **relay pool**, NIP-66 discovery, health scoring, advert relay-field signing, and handshake routing. Top-level surface: [signaling.md](signaling.md) · [transports.md](transports.md) · [mesh.md](mesh.md).

Source layout (`discovery/nostr/`):
- `index.mjs` — provider (presence / signal / advert subscriptions)
- `relays.mjs` — pool, health, NIP-66 discovery, normalization, persistence
- `selection.mjs` — handshake routing, backoff, fanout
- `session.mjs` — shared relay WebSocket sessions / subscribe primitives
- `constants.mjs` — hard limits

## Three-tier sets

`relayPool` (all known) → `workingRelays` (top-`WORKING_RELAYS_COUNT` by health) → `listenRelays` (top-`LISTEN_RELAYS_COUNT` working subset used for publish/listen).

- `public`/`manual` entries are **pinned**: always in `working`/`listen` and never evicted by `clearStale` or pool-cap. Pin count may exceed the nominal caps.
- `nip66`/`peer` entries are disposable: evicted when stale (`PROBE_STALE_MS`) or when the pool exceeds `POOL_CAP`.
- Fresh nodes are seeded with `DEFAULT_RELAY_URLS` (`source: 'public'`) so `listenRelays` is never empty at cold start.
- Persistent connections stay bounded by `workingRelays` (`WORKING_RELAYS_COUNT`, max 32); pins influence selection, not simultaneous connections.

## URL normalization (single ingress)

`normalizeNostrRelayUrl` (in `relays.mjs`) is the only entry for every inbound URL (NIP-66 `d` tag, manual config, peer advert):

- `wss://` always; `ws://` only for loopback/private hosts (local dev/tests).
- hostname lowercased, default port removed, trailing slashes removed, non-empty path kept.
- Invalid → `null` → dropped with an audit log (`nodeDebug('invalidRelayUrl', { url, reason })`), never silently cleaned.

## Health score

```
failureRate = failureCount / (successCount + failureCount)
rtt         = clamp(rttMs ?? DEFAULT_RTT_MS, 1, MAX_RTT_MS)
score       = rtt * (1 + failureRate * FAILURE_WEIGHT)     // FAILURE_WEIGHT = 4
score      *= STALE_PENALTY                                 // ×2 if lastProbe older than PROBE_STALE_MS
```

Lower is better. `recordProbeSuccess` / `recordProbeFailure` / `recordPublishResult` share the same counters. Writes to `nodeDir/nostr/relays.json` are **throttled** (2s debounce).

## Persistence

`nodeDir/nostr/relays.json`:

```json
{
  "updatedAt": 1234567890,
  "nostrRelays": [{ "url", "rttMs", "successCount", "failureCount", "lastSuccess", "lastFailure", "lastProbe", "firstSeen", "lastSeen", "source", "nips", "clearnet", "monitorCount" }],
  "peerRoutes": { "<nodeHash64>": { "listenRelays", "peerPool", "lastGoodNostrRelays", "webrtcLastOk", "lastSeen" } }
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

- `sanitizeAdvertRelayFields` (build **and** verify use the same function): pool ≤ `MAX_ADVERT_RELAY_POOL` (16), rtt ∈ [0, `MAX_RTT_MS`], deduped; listen ≤ `MAX_ADVERT_LISTEN_RELAYS` (32), deduped; dropped entries logged.
- `verifySignedAdvert` now returns `{ nodeHash, relayPool, listenRelays }` (sanitized). `ingest*Advert` passes these through; consumers must use the verified values, never the raw body.
- **Any tampering with relay fields invalidates the signature** → advert rejected.

## Handshake routing (`selection.mjs`)

`handshakeTargets(nodeHash, attempt)`:
- **Round 0**: peer-claimed `listenRelays` top 4 by composite score (own health + peer rtt); else local `workingRelays` top 4; else pinned top 4.
- **Round ≥1**: backoff `min(2000 · 2^(attempt−1), 60000)`; base on `lastGoodNostrRelays` (expanded via `expandFromHistory` ≤ 16), or weighted-random sample of `workingRelays` (weight `1/score`); round-0 core always included; fanout capped at `MAX_ROUTING_FANOUT` (64).
- Retries ≤ `MAX_ROUTING_ATTEMPTS` (4).

`routePublishEvent(toNodeHash, event, signal)`: publishes to the current round's targets in parallel via shared sessions; any `OK` records `lastGoodNostrRelays` (last 16) + success; all-fail records failures and backs off. `sendNodeSignal` uses routing; an explicit relay override (test/user pin) publishes directly.

## Config

`channels.nostr.relay` (non-empty array) **overrides** the whole relay set — published/subscribed relays come from that list, not the pool. Without it, `resolveNostrRelayUrls()` returns `getListenRelays()`.