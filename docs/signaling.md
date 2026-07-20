# Signaling & sparse-mesh notes

Internal WebRTC (`needsOfferAnswer`) and related mesh behavior. Shells use the fount-network API only — see [transports.md](transports.md).

## Glare: connId dual-PC pick-one

`node-datachannel` has no perfect-negotiation/rollback; simultaneous dials on one PC collide. Resolution in `transport/offer_answer.mjs`: both sides dial with a random `connId`; on true glare each side builds an independent answer PC, then **keeps the link initiated by the smaller `nodeHash`** (`linkIsPreferred`). Only the canonical link fires `linkUp` / `linkDown`.

- Outbound: `ensureDirectLinkToNode` → `dialOfferAnswer` → `createConnSession` + provider `dial`.
- Inbound offer with unknown `connId`: new answer PC via `accept` — **not** gated by per-`nodeHash` `inflights`.
- One-way dial never builds a second PC. Regression: `test/live/link_glare_two_pc.test.mjs`.

## Handshake: buffer early `auth`

Frames: `hello` then `auth`. On simultaneous dial, peer `auth` can arrive before peer `hello` — buffer it (`pendingAuth` in `link/pipe.mjs`); never drop. Regression: `test/pure/link_handshake_reorder.test.mjs`.

## Sparse group linking

No full-mesh autoconnect. `group_link_set` uses `selectLinkTargetsFromMembers` within `resolveFederationPoolLimits`: top-K trusted + M explore, denylist/quarantine filtered, **anchors always included**. `start()` dials once; membership changes debounce via `notePeerCandidate` (dial newly selected only; never proactive cut — `trimToBudget` is the backstop).

## DAG first-seen multi-hop relay

On a sparse mesh, `roomHandlers/sync.mjs` forwards first-seen valid events to `pickFederationTargetPeerIds` (minus sender). Relaying is not a reputation penalty.

## Windows / `trickleIceOff`

When set: send final offer/answer after ICE gathering, dedupe remote signals, queue remote ICE until both descriptions are ready.

## Live-test relay override

`init({ P2P: { signaling: { relayOverride, mdnsPolicy, trickleIceOff } } })`. `relayOverride` **replaces** the default public relay list (do not merge defaults back in).
