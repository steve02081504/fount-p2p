# fount network vs internal transports

Mesh keep-alive / discovery: [mesh.md](mesh.md). WebRTC glare / handshake: [signaling.md](signaling.md). Runtime lifecycle: [runtime.md](runtime.md).

## No versioning

Do **not** introduce version fields, constants, or suffixes (`v`, `version`, `FRAME_VERSION`, `:v1`, …). Changing a shape means changing it; no dual-read / backward-compat paths. Exception: npm `package.json` `version` is for package publish only.

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
| **Bootstrap** (`transport/runtime_bootstrap.mjs`) | `ensureRuntime` register + progressive listen/discovery/BT warm; `reloadDiscoveryRelays` on `signaling-changed` |
| **Offer/answer** (`transport/offer_answer.mjs`) | Discovery-signal glare path for `caps.needsOfferAnswer` (**internal**; uses `sendNodeSignalPacket`) |
| **Mesh keepalive** (`transport/mesh_keepalive.mjs`) | N/K pool, explore eviction, stable promote to `trustedPeers` |

LinkHandle for upper layers: `ready` / `nodeHash` / `send` / `onEnvelope` / `onDown` / `close` / `stats`. Transport-specific fields are for in-package scheduling only.

Provider optional hooks (package-internal): `ensureListening`, `localEndpoint`, `canReach`, `caps.probe: 'sync' | 'native'` (`native` = skipped on ensureRuntime fast-listen). Discovery `connectToNode` / `sendNodeSignal` may return `false` when the path is unavailable; fan-out treats that as silent skip. Per-provider throw/false in discovery and link dial fallback are silent; only total failure of the abstraction surfaces to the caller.

Each registry only calls `ensureListening` on **its own** `lan_tcp` / `ble_gatt` instances (unique registry ids like `lan_tcp:ab12cd34`). Never fan out listening to other registries' sockets.

Chain `providerId` on the LinkHandle stays the short name (`lan_tcp` / `ble_gatt` / `webrtc` / `nostr`) for scheduling/stats.

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

### `ble_gatt` (40)

GATT write/notify; binding = shared `linkId`; needs BT peer hint (`peripheralId` in discovery meta); optional noble/bleno. Per-registry instance like `lan_tcp`; `isAvailable` / `canReach` gate dial. On Win32, scan-only stacks cannot accept inbound BLE links. One BLE adapter cannot host two independent peripherals in-process — production is one node per process. Hardware probe: [runtime.md](runtime.md).

### `nostr` (−∞)

Last-resort duplex pipe over discovery signal packets (`type: 'link'`), demuxed from WebRTC `type: 'signal'`. Same node rendezvous encryption as signaling; not a second relay subscription. Longer handshake / heartbeat / idle than LAN. Discovery **`priority`** is unchanged (still handshake-last); only link **`level`** is −∞.

### Bluetooth discovery signal

`discovery/bt` carries short signal blobs on GATT so WebRTC can negotiate near-field when LAN/nostr are unavailable (package-internal).

Discovery peripheral and `ble_gatt` both use bleno + name `fount-bt`. On one adapter they contend — last `setServices`/`startAdvertising` wins. Production: one node per process.
