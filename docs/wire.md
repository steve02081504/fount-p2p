# Wire part / fanout attaches

Day-to-day trust rules: [AGENTS.md](../AGENTS.md). Node-scope presets: [infra.md](infra.md).

## Fanout vs targeted (attach inventory)

| Use | API | Notes |
|---|---|---|
| Timeline / chunk exploration | `fanoutToTopNodes` | TrustGraph-ranked fanout |
| Mailbox / targeted packets | `sendToNode` / User Room | Never fanout |
| part_invoke RPC collect | `wire/part/fanout.collectPartInvokeResponses` | Requires `attachPartWire` already |
| Group-room part | `wire/part/group.attachGroupPartWire` | Group federation frames |
| TrustGraph / group Trystero chunk | `files/chunk/responder.attachTrustGraphFedChunkResponder` | Chunk responder on trust/group path |

Part query runtime lives under `federation/part_query/*`; wire attach only in `wire/part/query.mjs`.
