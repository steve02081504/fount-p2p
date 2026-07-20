# Fount network vs internal transports

## Public contract (shell / L4)

This package exposes a **fount network**: talk to `nodeHash` peers with envelopes.

Typical entrypoints:

- `startNode` / `getLinkRegistry().ensureRuntime()`
- `ensureLinkToNode` / `sendToNodeLink` / `subscribeScope`
- `createGroupLinkSet` / `createScopedLinkRoom` / `ensureUserRoom`

Callers do **not** choose WebRTC, BLE, ICE, or DataChannels. If a path is unavailable on the host, the registry tries the next internal provider; the API surface stays the same.

`link/` and `link/providers/` are **package-private** (not in `package.json` `exports`). Do not import them from fount or other shells.

## Internal: discovery + link providers

| Layer | Role |
|---|---|
| **Discovery** (`discovery/`) | Find peers + optional signal bytes |
| **Link providers** (`link/providers/`) | Open a duplex pipe; sorted by **`level` (descending)** |
| **Registry** (`transport/link_registry.mjs`) | Fount-network facade: dial fallback, scope/overlay, one canonical link per peer |
| **Bootstrap** (`transport/runtime_bootstrap.mjs`) | `ensureRuntime` register + progressive listen/discovery/BT warm |
| **Offer/answer** (`transport/offer_answer.mjs`) | Discovery-signal glare path for `caps.needsOfferAnswer` |
| **Signal crypto** (`transport/signal_crypto.mjs`) | Rendezvous topics + AES-GCM signal packets |

LinkHandle for upper layers: `ready` / `nodeHash` / `send` / `onEnvelope` / `onDown` / `close` / `stats`. Transport-specific fields are for in-package scheduling only.

Provider optional hooks (package-internal): `ensureListening` (inbound accept), `localEndpoint` (e.g. LAN listen port for adverts), `canReach` (hint gate before dial), `caps.probe: 'sync' | 'native'` (`native` = `isAvailable` starts noble/wrtc — skipped on ensureRuntime fast-listen). Discovery `sendSignal` may return `false` when the path is unavailable (e.g. BT with no peer hint); fan-out treats that as silent skip. Per-provider throw/false in discovery and link dial fallback are silent; only total failure of the abstraction surfaces to the caller.

Each registry only calls `ensureListening` on **its own** `lan_tcp` / `ble_gatt` instances (unique registry ids like `lan_tcp:ab12cd34`). Never fan out listening to other registries' sockets — that would overwrite `localIdentity` / `onInbound`.

Chain `providerId` on the LinkHandle stays the short name (`lan_tcp` / `ble_gatt` / `webrtc`) for scheduling/stats.

## Level table (maintainers)

| id | level |
|---|---|
| `lan_tcp` | 80 |
| `webrtc` | 70 |
| `ble_gatt` | 40 |

Constants live in `link/providers/levels.mjs`. Discovery uses ascending **`priority`**. Link selection uses descending **`level`**.

## Fallback (internal)

1. `canReach` false → skip (no dial)
2. `isAvailable()` fails → skip (probed per provider on the dial path; never via `listAvailableLinkProviders()` first)
3. dial/handshake fails or soft-fails (`null`) → next lower level
4. races: higher `level` wins; same level → smaller `nodeHash` initiates

`caps.needsOfferAnswer` providers use the shared discovery-signal glare path (`dial`/`accept` + signal session). Any such provider works — not hard-coded to `id === 'webrtc'`.

## Implemented providers (internal notes)

### `lan_tcp` (80)

Plain TCP on the LAN. Registry schedules listen in the background after `ensureRuntime`; `buildLocalAdvert` waits for local listen so signed adverts (node self-topic **and** group/scoped room topics) include `tcpPort`. Peers learn `{ host, port }` from discovery meta (`address` / mDNS `rinfo`) + advert `tcpPort` (`discovery/advert_peer_hints.mjs`). Binding = shared `linkId`; length-prefix framing on the socket. No discovery signal / offer-answer. Shells never read `tcpPort` — only the fount-network abstraction.

### `webrtc` (70)

Discovery signal + dual DataChannel; DTLS fingerprint as handshake binding; `needsOfferAnswer` glare path. Soft-fail (`null`) continues to lower-level providers.

### `ble_gatt` (40)

GATT write/notify; binding = shared `linkId`; needs BT peer hint (`peripheralId` in discovery meta); optional noble/bleno. Per-registry instance like `lan_tcp`; `isAvailable` / `canReach` gate dial. On Win32, scan-only stacks cannot accept inbound BLE links. One BLE adapter cannot host two independent peripherals in-process — production is one node per process.

`@stoprocent/bleno` characteristic callbacks take a leading `connection` argument (`onWriteRequest(connection, data, offset, withoutResponse, callback)`). Hardware probe / Windows caveats: [runtime.md](runtime.md).

### Bluetooth discovery signal

`discovery/bt` carries short signal blobs on GATT so WebRTC can negotiate near-field when LAN/nostr are unavailable (package-internal).

Discovery peripheral (`…f017`) and `ble_gatt` (`…f019`) both use bleno + name `fount-bt`. On one adapter they contend — last `setServices`/`startAdvertising` wins. Production: one node per process.
