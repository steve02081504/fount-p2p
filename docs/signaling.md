# Signaling

Internal WebRTC (`needsOfferAnswer`) glare and handshake. Shells use the fount-network API only — [transports.md](transports.md). Discovery / mesh surface: [mesh.md](mesh.md).

## Glare: connId dual-PC pick-one

`node-datachannel` has no perfect-negotiation/rollback; simultaneous dials on one PC collide. Resolution in `transport/offer_answer.mjs`: both sides dial with a random `connId`; on true glare each side builds an independent answer PC, then **keeps the link initiated by the smaller `nodeHash`** (`linkIsPreferred`). Only the canonical link fires `linkUp` / `linkDown`.

- Outbound: `ensureDirectLinkToNode` → `dialOfferAnswer` → `createConnSession` + provider `dial`.
- Inbound offer with unknown `connId`: new answer PC via `accept` — **not** gated by per-`nodeHash` inflights.
- One-way dial never builds a second PC. Regression: `test/live/link_glare_two_pc.test.mjs`.

## Handshake: buffer early `auth`

Frames: `hello` then `auth`. On simultaneous dial, peer `auth` can arrive before peer `hello` — buffer it (`pendingAuth` in `link/pipe.mjs`); never drop. Regression: `test/pure/link_handshake_reorder.test.mjs`.

## Windows / `trickleIceOff`

When set: send final offer/answer after ICE gathering, dedupe remote signals, queue remote ICE until both descriptions are ready.

## Runtime relay override

`setSignalingRuntimeConfig({ relayOverride, iceLocalHostnamePolicy, trickleIceOff })` after `initNode` (or pass `signaling` once on first `startNode`). `relayOverride` **replaces** the default public relay list (do not merge defaults back in). Changes emit `signaling-changed` and trigger `reloadDiscoveryRelays` (swap Nostr provider + rebind node presence/signals).
