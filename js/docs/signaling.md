# Signaling

Internal WebRTC (`needsOfferAnswer`) glare and handshake. Shells use the fount-network API only — [transports.md](transports.md). Discovery / mesh surface: [mesh.md](mesh.md).

## Glare: connId dual-PC pick-one

`node-datachannel` / `node-rtc-connection` cannot safely host two simultaneous glare dials on one PC. Resolution in `transport/offer_answer.mjs`: both sides dial with a random `connId`; on true glare each side builds an independent answer PC, then **keeps the link initiated by the smaller `nodeHash`** (`linkIsPreferred`). Only the canonical link fires `linkUp` / `linkDown`.

- Outbound: `ensureDirectLinkToNode` → `dialOfferAnswer`.
- Inbound offer with unknown `connId`: new answer PC via `accept` — **not** gated by per-`nodeHash` inflights.
- One-way dial never builds a second PC.

## Handshake: buffer early `auth`

Frames: `hello` then `auth`. On simultaneous dial, peer `auth` can arrive before peer `hello` — buffer it (`pendingAuth` in `link/pipe.mjs`); never drop.

## Windows / `trickleIceOff`

When set: send final offer/answer after ICE gathering, dedupe remote signals, queue remote ICE until both descriptions are ready.

## Runtime channels

`setSignalingRuntimeConfig({ channels })` after `initNode` (or pass `signaling` once on first `startNode`). Changes emit `signaling-changed` and trigger `reloadDiscoveryRelays` (rebind discovery providers + node presence/signals).

`channels` selects which discovery/link media are active — `nostr`, `lan`, `bt`, `webrtc`. Semantics per channel key: `false` **disables**; any other value (`undefined`, `true`, or an object) **enables** — an object is merged over that channel's default config. Channels not mentioned keep their default enabled state.

Channel → components:
- `nostr` (nostr discovery + nostr link) — config `relay` **replaces** the default public relay list (do not merge defaults back in).
- `lan` (lan discovery + lan_tcp link)
- `bt` (bt discovery + ble_gatt link)
- `webrtc` (webrtc link data-transport fallback) — config `iceLocalHostnamePolicy` (`none` / `rewrite-loopback` / `drop`, Windows defaults `drop`) and `trickleIceOff` (send final offer/answer after ICE gathering).

To run a node on only a few channels, use the `disableAllChannels` helper: `{ channels: disableAllChannels({ nostr: { relay: [...] } }) }` enables only `nostr` (with its per-channel relay) and disables the rest; use `true` to enable a channel with its default config (`disableAllChannels({ nostr: true, webrtc: true })`).
