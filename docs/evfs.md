# EVFS manifests & fetch

Day-to-day package rules: [AGENTS.md](../AGENTS.md). Implementation: `files/` (`evfs`, `evfs_ref`, `chunk/*`, `manifest/*`).

## Storage

| What | Path |
| --- | --- |
| Ciphertext chunks (CAS) | `{nodeDir}/chunks/` |
| Manifests | `{EntityStoreRoot}/{entityHash}/files/{path}.manifest.json` |

## Public publish / verify

- `publishPublicFile` signs with the recovery key.
- Remote path: `fed_manifest_get` → `verifySignedPublicManifest` → cache.
- Signature covers **content fields only**. After verify, drop incoming `meta` except `publicSig`.
- Profile / avatar meaning belongs in the shell — not in this package.

## `fetchManifest`

| Case | Behavior |
| --- | --- |
| Default options | Node-scope fanout; **only** signed public manifests accepted; no cache write |
| Local public hit with `publicSig` | Return immediately; fanout revalidates in the background. With `cache: true`, write only when remote `publishedAt` is newer |
| Local non-public hit | Return immediately (**targeted mode only**); no revalidation (no publish order to compare); public mode refuses non-public local |
| `fanoutTargets` given | Fanout **only** to that node set; accepts signed public **or** normalized non-public manifests; non-public hit is cached locally by default |
| Same key in flight | Deduped via `utils/inflight_table` (key includes `public`/`targeted` mode) |

Outer caller timeouts must **not** abort the in-flight work — background fill continues after the caller gives up.

## Non-public (ACL-gated) manifests

- `file-master-key-wrap` / `vault-wrap` / `identity-wrap` manifests carry no author signature, so the remote-acquisition trust boundary is **not** a signature — it is the **fanout target set** plus the **serving node's authorization**.
- Client: the caller passes the authorized node set (group roster / cabinet members) as `fanoutTargets`. `fed_manifest_get` is sent only to those nodes; a response is accepted when it normalizes, its `ownerEntityHash`+`logicalPath` match the request, and its authenticated `senderNodeHash` belongs to the target set.
- Server: `handleIncomingManifestGet` refuses non-public manifests unless a **servicer** is registered for the matched owner family. Shells call `registerManifestOwner(ownerId, match)` to claim ownership and `registerManifestServicer(ownerId, handler)` to serve; the handler receives `{ manifest, ownerEntityHash, logicalPath, requesterNodeHash, peerId, payload }` and returns a boolean. `requesterNodeHash` is **always** the transport-authenticated sender nodeHash (`peerId`); the client no longer self-asserts a `nodeHash` in `fed_manifest_get`, so the fanout target node can never be mistaken for the requester — authorization must still be enforced from the trust graph / group membership.
- Non-public responses carry the **full manifest including `meta`** (public responses strip meta to `publicSig`): the reader needs `meta.dagParts` / `meta.groupId` to read DAG plaintext.
- Confidentiality does not rely on manifest secrecy: ciphertext blocks are content-addressed, AES-GCM authenticated, and decryption requires a wrap key held by the shell. A forged manifest can at worst fail the read (DoS), never decrypt content.

## ACL & owner routing

- Ownership is decided **only** by matchers: `registerManifestOwner(ownerId, match)` with `match(manifest, ownerEntityHash)` returning a boolean. `transferKeyDescriptor.type` is **not** a routing key — the same type (e.g. `file-master-key-wrap`) may be reused by several families (chat group, cabinet shared, vault, …).
- Matchers must be mutually exclusive: a manifest belongs to exactly one family; resolution is first-match in registration order. A broad matcher that claims another family's entities will shadow them, so matchers should key on their own entity namespace (e.g. the `fount:chat:group:` prefix).
- Local read/write ACL (`registerManifestAcl(ownerId, handler)`) and cross-node serve (`registerManifestServicer(ownerId, handler)`) are both keyed by `ownerId` (same `ownerId` as `registerTransferKeyDependencies`). A claimed family with no handler denies (fail-closed); an unclaimed non-public manifest is denied cross-node — there is no `type` fallback.
- Core does not hard-code chat/social entity types.
