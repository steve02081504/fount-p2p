# fount network vs internal transports

Mesh keep-alive / discovery: [mesh.md](mesh.md). WebRTC glare / handshake: [signaling.md](signaling.md). Runtime lifecycle: [runtime.md](runtime.md).

## No versioning

Do **not** introduce version fields, constants, or suffixes (`v`, `version`, `FRAME_VERSION`, `:v1`, …). Changing a shape means changing it; no dual-read / backward-compat paths. Exception: npm `package.json` `version` is for package publish only.

## Overlay relay authenticity

`overlay/index.mjs` multi-hop relay carries an origin signature: `relay()` signs `(path, body)` with the origin key, intermediate hops forward `nodePubKey`/`sig` untouched, and the terminal node verifies `pubKeyHash(nodePubKey) === path[0]` before treating the body as sent by that node. Unsigned or forged relays are dropped. `route_resp` is only accepted when the signed path's last hop equals the discovery target. Overlay `route_req`/`relay` are token-bucket limited by default (`overlay/tunables.json`, 120/min burst 30); `startInfra` may override the gate.

## Public contract (shell / L4)

This package exposes a **fount network**: talk to `nodeHash` peers with envelopes.

Typical entrypoints:

- `startNode` / `getLinkRegistry().ensureRuntime()`
- `ensureLinkToNode` / `sendToNodeLink` / `subscribeScope`
- `createGroupLinkSet` / `createScopedLinkRoom` / `ensureUserRoom`

`registerScopeAuthorizer` may be called before `initNode` / `getLinkRegistry` — it only buffers policy until the default registry is created.

Callers do **not** choose WebRTC, BLE, ICE, or DataChannels. If a path is unavailable on the host, the registry tries the next internal provider; the API surface stays the same.

**Public registration only:** `registerLinkProvider` / `registerDiscoveryProvider` from the package facade or `@steve02081504/fount-p2p/link` / `./discovery`. Provider *implementations* under `link/providers/*` remain package-internal — shells must not import them or pick transports.

Public `./transport/*` subpaths: `link_registry`, `user_room`, `group_link_set`, `node_scope/wire`, `node_scope/features`, `room_scopes`, `remote_user_room`, `scoped_link`. There is no `transport/node_scope` barrel — import the concrete modules. Modules such as `offer_answer`, `runtime_bootstrap` are internal.

Topic / rendezvous / signal crypto live under `discovery/` (`nostr.mjs`, `internal/signal_crypto.mjs`, `adverts.mjs`) — not in `transport/`, not a package export. Do not export `advertiseTopic` / `subscribeTopic` / `sendSignal(topic)` on the fount-network surface. ICE `.local` host-candidate filtering is `iceLocalHostnamePolicy` only.

## Internal layers

| Layer | Role |
| --- | --- |
| **Discovery** (`discovery/`) | Per medium: `listVisibleNodeHashes` + `connectToNode`. Encrypted adverts/signals via `adverts.mjs` + `index.mjs` helpers. |
| **Link providers** (`link/providers/`) | Open a duplex pipe; sorted by **`level` (descending)** — not a shell import |
| **Registry** (`transport/link_registry.mjs`) | fount-network facade: dial fallback, scope/overlay, one canonical link per peer |
| **Bootstrap** (`transport/runtime_bootstrap.mjs`) | `ensureRuntime` register + progressive listen/discovery; `ensureChannelAvailable` for BT discovery; `reloadDiscoveryRelays` on `signaling-changed` |
| **Offer/answer** (`transport/offer_answer.mjs`) | Discovery-signal glare path for `caps.needsOfferAnswer` (**internal**; uses `sendNodeSignalPacket`) |
| **Mesh keepalive** (`transport/mesh_keepalive.mjs`) | N/K pool, explore eviction, stable promote to `trustedPeers` |

LinkHandle for upper layers: `ready` / `nodeHash` / `send` / `onEnvelope` / `onDown` / `close` / `stats`. Transport-specific fields are for in-package scheduling only.

Provider optional hooks (package-internal): `ensureListening`, `localEndpoint`, `canReach`, `caps.probe: 'sync' | 'native'` (`native` = skipped on ensureRuntime fast-listen). Discovery `connectToNode` / `sendNodeSignal` may return `false` when the path is unavailable; fan-out treats that as silent skip. Per-provider throw/false in discovery and link dial fallback are silent; only total failure of the abstraction surfaces to the caller.

Each registry only owns its own `lan_tcp` / `ble_gatt` instances (unique registry ids like `lan_tcp:ab12cd34`), so those are listened to per registry. Every other **registered and enabled** provider (e.g. `nostr`, `webrtc`) is listened to by the registry that can see it: `ensureRuntime` and `reloadDiscoveryRelays` call `ensureListening` on any enabled provider that has no registered stop function yet. A provider registered later — notably the fresh instance `reconcileLinkProviders()` installs when a channel is toggled off and back on — must be picked up by that pass, otherwise it silently drops every inbound `link-open` (a missing listener is logged as `p2p:nostr link-open dropped — listener not attached`).

Chain `providerId` on the LinkHandle stays the short name (`lan_tcp` / `ble_gatt` / `webrtc` / `nostr`) for scheduling/stats.

## Bounded waits (no unbounded dial / publish)

Nothing on the dial path may wait forever:

- Intra-relay publish (`discovery/nostr/session.mjs`): a request queued behind a relay that never completes its WebSocket connect is rejected with a connect-stage error after `NOSTR_QUEUED_PUBLISH_DEADLINE_MS`, and the session is reclaimed. The EVent OK timeout only starts once a socket is open, so it cannot cover the connect stage.
- Relay fan-out (`discovery/nostr/index.mjs` `publishEvent`): resolves as soon as **one** relay accepts; the remaining publishes keep running in the background but are bounded by the above.
- One `ensureLinkToNode` (`transport/link_registry.mjs`): bounded by `LINK_DIAL_DEADLINE_MS` (larger than the publish deadline, so a dead relay normally fails through the provider's own error path). On timeout the in-flight promise is dropped from `inflights` so later dials start a fresh attempt instead of reusing a stuck one.

`kotlin/` mirrors all three; there a connect coroutine holding `sessionMutex` must also be cancellable (see [kotlin/AGENTS.md](../../kotlin/AGENTS.md)).

## Level table

| id | level |
| --- | --- |
| `lan_tcp` | 80 |
| `webrtc` | 70 |
| `ble_gatt` | 40 |
| `nostr` | −∞ |

Constants: `link/providers/levels.mjs`. Discovery uses ascending **`priority`** (handshake / presence / signal media order — Nostr stays last at `100`). Link selection uses descending **`level`** (data transport); Nostr is −∞ so it is dialed only after LAN / WebRTC / BLE fail.

## Fallback

1. `canReach` false → skip (no dial)
2. `isAvailable()` fails → skip (probed per provider on the dial path; never via `listAvailableLinkProviders()` first)
3. dial/handshake fails or soft-fails (`null`) → next lower level
4. races: higher `level` wins; same level → smaller `nodeHash` initiates

`caps.needsOfferAnswer` providers use the shared discovery-signal glare path (`dial`/`accept` + signal session) — not hard-coded to `id === 'webrtc'`.

Dial miss / exhausted peers get exponential cooldown so mesh ticks do not busy-loop on stale acquaintances. First-seen discovery peer clues (and `watchNodeAdvert` ingest) clear that peer's cooldown.

## Providers (internal)

### `lan_tcp` (80)

Plain TCP on the LAN. Registry schedules listen in the background after `ensureRuntime`; `buildLocalAdvert` waits for local listen so signed adverts include `tcpPort`. Peers learn `{ host, port }` from discovery meta + advert `tcpPort`. Binding = shared `linkId`; length-prefix framing. No discovery signal / offer-answer. Shells never read `tcpPort`.

### `webrtc` (70)

Discovery signal + dual DataChannel; DTLS fingerprint as handshake binding; `needsOfferAnswer` glare path. Soft-fail (`null`) continues to lower-level providers. Backend: `node-datachannel` when the native addon loads, else pure-JS `node-rtc-connection` (Android/Termux skips native). See [runtime.md](runtime.md).

Every link gathers local ICE candidates first and then sends one offer/answer (there is no trickle mode: a peer must already hold the remote description before it accepts candidates). `collectIceGathering` (`link/providers/webrtc.mjs`) therefore does not wait for `iceGatheringState === 'complete'` alone — server-side polyfills leave the state at `gathering` when every relay times out or when the local-hostname policy drops all host candidates. It also finishes on a quiet candidate stream (`ICE_CANDIDATE_SETTLE_MS`) and gives up after `ICE_GATHERING_STALL_MS` when nothing was gathered, so DTLS/data-channel timeouts decide instead of a hard failure. `handshakeTimeoutMs` remains the hard stop on every path. Progress is counted from `icecandidate` events, not SDP diffs, because `localDescription.sdp` carries no candidate lines on those backends.

When the configured local-hostname policy drains every candidate the link cannot work at all, so the initiator escalates through `ICE_LOCAL_HOSTNAME_LADDER` (`drop` → `none`) and rebuilds the peer connection per rung; the responder follows the rung named in the offer. Nothing here is platform-specific. Details: [signaling.md](signaling.md).

### `ble_gatt` (40)

GATT write/notify; binding = shared `linkId`; needs BT peer hint (`peripheralId` in discovery meta); optional noble/bleno. Per-registry instance like `lan_tcp`; `isAvailable` / `canReach` gate dial. On Win32, scan-only stacks cannot accept inbound BLE links. One BLE adapter cannot host two independent peripherals in-process — production is one node per process. Hardware probe: [runtime.md](runtime.md).

### `nostr` (−∞)

Last-resort duplex pipe over discovery signal packets (`type: 'link'`), demuxed from WebRTC `type: 'signal'`. Same node rendezvous encryption as signaling; not a second relay subscription. Longer handshake / heartbeat / idle than LAN. Discovery **`priority`** is unchanged (still handshake-last); only link **`level`** is −∞.

### Bluetooth discovery signal

`discovery/bt` carries short signal blobs on GATT so WebRTC can negotiate near-field when LAN/nostr are unavailable (package-internal).

Discovery peripheral and `ble_gatt` both use bleno + name `fount-bt`. On one adapter they contend — last `setServices`/`startAdvertising` wins. Production: one node per process.
