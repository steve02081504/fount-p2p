# Mesh policy

A fount node's **first job is to join and stay on the fount network**. Link presence is not business trust: discovery and dialing stay aggressive; trust and fanout are constrained by reputation / TrustGraph / denylist.

Do **not** treat "unrelated ⇒ no interconnect" or "no common group ⇒ no dial" as design premises. Nodes with no acquaintances, no shared groups, and no shell intro must still reach the network via discovery media.

## No versioning

No version fields, no backward-compat dual-parse paths. Shape changes replace the shape. Details: [transports.md](transports.md). Exception: npm package version is for publish only.

## Discovery: no topic on the fount-network surface

Each discovery / scannable medium exposes only:

1. `listVisibleNodeHashes({ limit? })` → `nodeHash[]` visible on that medium
2. `connectToNode(nodeHash)` → dial via registry (`setDiscoveryLinkDialer` → `ensureLinkToNode`, which calls `prepareConnectToNode` inside the dialer; without dialer, facade only prepares)

Scans with `roomSecret` return **only that group's visible pool**. Media without group semantics (LAN / BT) return `[]` — do not pour network/LAN nodes into group membership.

Topic, relay tags, rendezvous keys, and signal crypto live **only** under `discovery/` (`nostr.mjs`, `internal/signal_crypto.mjs`, `adverts.mjs`). Group flows pass `roomSecret` and other business keys; transport only sees `nodeHash` / opaque bytes.

Visible pools (Nostr / BT / LAN) only accept **signature-verified** adverts (`acceptNostrAdvert` / `acceptBtScannedPresence` / `acceptLanPresenceAdvert`); forged `body.nodeHash` after decrypt alone does not enter the pool. BT scan also records `peripheralId` via `noteAdvertPeerHints` so `connectToNode` / `ble_gatt` can dial.

Group presence / advert watch / signaling fan-in **all** providers that implement the methods — do not hard-bind `nostr` id.

No discovery-layer mDNS. LAN UDP presence must carry signed+encrypted network `advertBytes`; unsigned `nodeHash` beacons are ignored. WebRTC ICE `.local` host-candidate filtering is `iceLocalHostnamePolicy` (unrelated to discovery).

| Medium | Scan | Dial |
|---|---|---|
| Nostr | Internal rendezvous; surface is hash list only | Internal signal + trigger link |
| lan_tcp | Segment presence/beacon (not topic) | TCP dial |
| BT | Near-field scan | GATT / near-field assist |

## Keep-alive: N links, K + (N−K)

After `ensureRuntime`, aim for at least **N** active peer links (subject to `maxActive` / routing profile — "no acquaintances" is never an excuse for N=0):

| Slot | Count | Source | Selection |
|---|---|---|---|
| Acquaintance | **K** (`K ≤ N`) | `trustedPeers` / high reputation / recent stable peers | High confidence first |
| Explore | **N−K** | `listVisibleNodeHashes` + PEX/hints | Continuous try; rotate on failure |

Explore keeps the node reachable when acquaintances are offline. Stable explore peers (default 30min, `meshPromoteStableMs`) promote via `promoteExplorePeer` into `trustedPeers`.

`transport/mesh_keepalive.mjs`: explore eviction when full; acquaintance rebalance may kick explore slots; proactive close does not sticky re-dial; inbound non-acquaintance peers are tagged explore.

### K = 0 (new node / empty trust table)

**N−K = N**: automatically `listVisibleNodeHashes` + `connectToNode` on each medium — do not idle waiting for the shell to inject friends.

## Trust boundary (linked ≠ trusted)

- **Dial / keep-alive / overlay:** connectivity first.
- **Federation fanout, reputation seeding:** TrustGraph / reputation / denylist; explore slots default low trust.
- **Inbound payloads:** untrusted ingress — see [AGENTS.md](../AGENTS.md).

## Sparse group linking (orthogonal)

Within a **known member set**, `group_link_set` dials sparsely for budget (`selectLinkTargetsFromMembers` within `resolveFederationPoolLimits`: top trusted + explore, denylist/quarantine filtered, **anchors always included**). Member discovery uses `listVisibleNodeHashes({ roomSecret })` + `connectToNode` — **not** `subscribe(groupTopic)`.

`start()` dials once; membership changes debounce via `notePeerCandidate` (dial newly selected only; never proactive cut — `trimToBudget` is the backstop). This is a budget choice on the member graph, not a ban on linking outside the group.

On a sparse group mesh, `roomHandlers/sync.mjs` forwards first-seen valid events to `pickFederationTargetPeerIds` (minus sender). Relaying is not a reputation penalty.

## See also

- [transports.md](transports.md)
- [signaling.md](signaling.md)
- [runtime.md](runtime.md)
