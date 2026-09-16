# Wire part / fanout attaches

Day-to-day trust rules: [AGENTS.md](../AGENTS.md). Node-scope presets: [infra.md](infra.md).

## Fanout vs targeted (attach inventory)

| Use | API | Notes |
| --- | --- | --- |
| Timeline / chunk exploration | `fanoutToTopNodes` | TrustGraph-ranked fanout |
| Mailbox / targeted packets | `sendToNode` / User Room | Never fanout |
| part_invoke RPC collect | `wire/part/fanout.collectPartInvokeResponses` | Requires `attachPartWire` already; `timeoutMs` bounds end-to-end |
| Group-room part | `wire/part/group.attachGroupPartWire` | Group federation frames |
| TrustGraph / group Trystero chunk | `files/chunk/responder.attachTrustGraphFedChunkResponder` | Chunk responder on trust/group path |

Part query runtime lives under `federation/part_query/*`; wire attach only in `wire/part/query.mjs`.

## Part query response signing / source attribution

- Every `part_query_res` is self-signed by the responding node: `parsePartQueryRes` requires `nodePubKey` (64 hex) + `sig` (128 hex), and the runtime verifies `pubKeyHash(nodePubKey) === fromNodeHash` plus the signature over `(requestId, fromNodeHash, rows)` before accepting. Invalid responses are dropped, so a neighbor cannot forge a result or attribute it to another node.
- `queryNetwork` returns `{ rows, sources }` (not a bare array), where `sources` is a `Map<rowKey, string[]>` of contributing responder nodeHashes. Cached entries keep the same provenance.
- `options.isSourceBlocked(nodeHash)` filters rows whose source set is non-empty and entirely blocked. Shells wire this to their source-block UI; local rows have an empty source set and are never filtered here.

## Timed collect

APIs with `timeoutMs` (e.g. `collectPartInvokeResponses`) must register the wait **first** and must **not** `await` fanout/send on the return path — a stuck `discoverRoute` / `link.send` otherwise defeats the timeout.

Pattern: `beginFedFanoutFetch` / fire-and-forget fanout + `sent === 0 → finish()`.
