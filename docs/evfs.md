# EVFS public manifests & fetch

Day-to-day package rules: [AGENTS.md](../AGENTS.md). Implementation: `files/` (`evfs`, `evfs_ref`, `chunk/*`, `manifest/*`).

## Storage

| What | Path |
|---|---|
| Ciphertext chunks (CAS) | `{nodeDir}/chunks/` |
| Manifests | `{EntityStoreRoot}/{entityHash}/files/{path}.manifest.json` |

## Public publish / verify

- `publishPublicFile` signs with the recovery key.
- Remote path: `fed_manifest_get` → `verifySignedPublicManifest` → cache.
- Signature covers **content fields only**. After verify, drop incoming `meta` except `publicSig`.
- Profile / avatar meaning belongs in the shell — not in this package.

## `fetchPublicManifest`

| Case | Behavior |
|---|---|
| Default options | No cache write |
| Local hit with `publicSig` | Return immediately; fanout revalidates in the background. With `cache: true`, write only when remote `publishedAt` is newer |
| Cold miss | Await fanout |
| Same key in flight | Deduped via `utils/inflight_table` (reuse + touch-to-tail; when over cap, cancel the aged front only if past `baseTimeoutMs`) |

Outer caller timeouts must **not** abort the in-flight work — background fill continues after the caller gives up.

## ACL

Shells register matchers via the ACL registry. Core does not hard-code chat/social entity types.
