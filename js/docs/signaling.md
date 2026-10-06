# Signaling

Internal WebRTC (`needsOfferAnswer`) glare and handshake. Shells use the fount-network API only — [transports.md](transports.md). Discovery / mesh surface: [mesh.md](mesh.md).

## Glare: connId dual-PC pick-one

`node-datachannel` / `node-rtc-connection` cannot safely host two simultaneous glare dials on one PC. Resolution in `transport/offer_answer.mjs`: both sides dial with a random `connId`; on true glare each side builds an independent answer PC, then **keeps the link initiated by the smaller `nodeHash`** (`linkIsPreferred`). Only the canonical link fires `linkUp` / `linkDown`.

- Outbound: `ensureDirectLinkToNode` → `dialOfferAnswer`.
- Inbound offer with unknown `connId`: new answer PC via `accept` — **not** gated by per-`nodeHash` inflights.
- One-way dial never builds a second PC.

## Handshake: buffer early `auth`

Frames: `hello` then `auth`. On simultaneous dial, peer `auth` can arrive before peer `hello` — buffer it (`pendingAuth` in `link/pipe.mjs`); never drop.

## ICE candidate gathering and the local-hostname ladder

There is no `trickleIceOff` switch: candidates travel inside the description, because a peer must already hold the remote description before it accepts candidates. Every link therefore gathers locally first and then sends one offer/answer.

`.local` (mDNS) host candidates are usually unresolvable for the peer, so the default policy drops them. When that leaves the local candidate set **empty**, the link cannot work no matter what the peer supports, so the initiator escalates to the next, more permissive policy and rebuilds the peer connection on that rung (`ICE_LOCAL_HOSTNAME_LADDER` in `node/signaling_config.mjs`; `iceLocalHostnameLadder` derives the rungs from the configured start):

1. `drop` — solve the mDNS problem by not offering the candidate.
2. `none` — offer everything and let the peer decide.

This decision is driven purely by the observed candidate set, never by the platform, so any backend on any host follows the same path. `rewrite-loopback` is not part of the ladder (rewriting a candidate to `127.0.0.1` is only useful same-machine); it stays available as an explicit start and, when set, is used alone.

Each rung is a **fresh link attempt** — new peer connection, new offer, new DTLS fingerprint — not a renegotiation of a live connection, so `pipe` fingerprint-binding semantics are unchanged. The offer carries the rung number; the responder rebuilds on that same rung and echoes it in the answer and never escalates on its own, which keeps convergence bounded. The whole ladder shares the `handshakeTimeoutMs` budget.

Gathering itself is bounded by `collectIceGathering` (`link/providers/webrtc.mjs`): it finishes on `iceGatheringState === 'complete'`, on a quiet candidate stream after candidates arrived (`ICE_CANDIDATE_SETTLE_MS`), or after `ICE_GATHERING_STALL_MS` when nothing was gathered at all — the last case is logged, and DTLS/data-channel timeouts decide instead of a hard 10s failure. `handshakeTimeoutMs` stays the hard stop on every path, including the quiet-window wait. Server-side polyfills (`node-datachannel`) deliver candidates only through `icecandidate` events and `localDescription.sdp` carries no candidate lines, so progress is counted from events rather than by diffing SDP.

## Runtime channels

`setSignalingRuntimeConfig({ channels })` after `initNode` (or pass `signaling` once on first `startNode`). Changes emit `signaling-changed` and trigger `reloadDiscoveryRelays` (rebind discovery providers + node presence/signals).

`channels` selects which discovery/link media are active — `nostr`, `lan`, `bt`, `webrtc`. Semantics per channel key: `false` **disables**; any other value (`undefined`, `true`, or an object) **enables** — an object is merged over that channel's default config. Channels not mentioned keep their default enabled state.

Channel → components:

- `nostr` (nostr discovery + nostr link) — config `relay` **replaces** the default public relay list (do not merge defaults back in).
- `lan` (lan discovery + lan_tcp link)
- `bt` (bt discovery + ble_gatt link)
- `webrtc` (webrtc link data-transport fallback) — config `iceLocalHostnamePolicy` is the ladder's **start** (`drop` by default; `none`, or `rewrite-loopback` for same-machine debugging).

To run a node on only a few channels, use the `disableAllChannels` helper: `{ channels: disableAllChannels({ nostr: { relay: [...] } }) }` enables only `nostr` (with its per-channel relay) and disables the rest; use `true` to enable a channel with its default config (`disableAllChannels({ nostr: true, webrtc: true })`).
