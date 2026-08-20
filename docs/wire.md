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

## Timed collect

APIs with `timeoutMs` (e.g. `collectPartInvokeResponses`) must register the wait **first** and must **not** `await` fanout/send on the return path — a stuck `discoverRoute` / `link.send` otherwise defeats the timeout.

Pattern: `beginFedFanoutFetch` / fire-and-forget fanout + `sent === 0 → finish()`.
