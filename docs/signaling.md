# Signaling & sparse-mesh notes

Internal WebRTC (`needsOfferAnswer`) and related mesh behavior. Shells use the fount-network API only — see [transports.md](transports.md).

## Glare: connId dual-PC pick-one

`link/pipe.mjs` has no WebRTC perfect-negotiation/rollback (`node-datachannel` cannot rollback). Simultaneous dials on one PeerConnection collide (`have-local-offer` ×2 → `InvalidStateError`).

Resolution in `link_registry.mjs`: both sides dial with a random `connId`; on true simultaneous dial each side builds an independent answer PC for the peer's `connId`, then **deterministically keeps the link initiated by the smaller `nodeHash`** (`linkIsPreferred`). Winner becomes canonical before the loser closes (`close('glare-loser')`); only the canonical link fires `linkUp` / `linkDown`.

- Outbound: `ensureDirectLinkToNode` → `createConnSession(remote, connId)` + provider `dial`; frames `{ type: 'signal', from, connId, body }`.
- Inbound offer with unknown `connId`: new answer PC via `accept` — **not** gated by per-`nodeHash` `inflights` (required for bidirectional setup).
- One-way dial never builds a second PC. Regression: `test/live/link_glare_two_pc.test.mjs`.

## Handshake: buffer early `auth`

Frames: `hello` then `auth` (`sign(peerNonce + localBinding + localNodeHash)`). On simultaneous dial, peer `auth` can arrive before peer `hello`. **Buffer it** (`pendingAuth` in `link/pipe.mjs`); never drop — otherwise `remoteAuthVerified` stays false and the link times out. Regression: `test/pure/link_handshake_reorder.test.mjs`.

## Sparse group linking

No full-mesh autoconnect. `group_link_set` uses `selectLinkTargetsFromMembers` (`peer_pool.mjs`) within `resolveFederationPoolLimits`: top-K trusted + M explore, denylist/quarantine filtered, **anchors always included**. `start()` dials once; membership changes debounce via `notePeerCandidate` (dial newly selected only; never proactive cut — `trimToBudget` is the backstop).

## DAG first-seen multi-hop relay

On a sparse mesh, `roomHandlers/sync.mjs` forwards first-seen valid events (`tryMarkSeenFederationEvent` + `ingestRemoteEvent` not `invalid`) to `pickFederationTargetPeerIds` (minus sender). Relaying is not a reputation penalty.

## Windows / `trickleIceOff`

When `trickleIceOff` is set: send final offer/answer after ICE gathering, dedupe remote signals, queue remote ICE until both descriptions are ready. Avoids `node-datachannel` "remote candidate without ICE transport" / duplicate-answer errors.

## Live-test relay override

Live tests inject relays via `init({ P2P: { signaling: { relayOverride, mdnsPolicy, trickleIceOff } } })`. Honor `getSignalingRuntimeConfig().relayOverride` on all discovery paths.
