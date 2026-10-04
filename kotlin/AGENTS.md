# fount-p2p Kotlin port guide

This directory is the Kotlin/JVM equivalent of `js/` (`@steve02081504/fount-p2p`); the artifact is a plain Android/JVM library consumable as a Maven dependency.

## Build / test

On this machine use JDK 17–21 (Android Studio's bundled JBR = 21 recommended) and `GRADLE_USER_HOME=E:\Gradle` (the Kotlin 2.2.10 plugin, BouncyCastle, Gson, coroutines and JUnit4 are cached there, so offline builds work).

```powershell
$env:GRADLE_USER_HOME = 'E:\Gradle'
$env:JAVA_HOME = 'E:\Android Studio\jbr'
.\gradlew.bat test --offline --console=plain                 # all tests
.\gradlew.bat test --offline --console=plain --tests 'io.github.steve02081504.fountp2p.core.*'
.\gradlew.bat compileKotlin --offline --console=plain        # main sources only
```

On this machine the default Windows `TEMP` directory makes the JVM's Unix domain socket fail inside `Selector.open()` with `Unable to establish loopback connection` / `Invalid argument: connect`. A separate socket directory is therefore configured for the Gradle client and daemon in `E:\Gradle\gradle.properties`:

```properties
systemProp.jdk.net.unixdomain.tmpdir=E:/Gradle/socket-tmp
org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8 -Djdk.net.unixdomain.tmpdir=E:/Gradle/socket-tmp
```

`E:\Gradle\init.d\windows-socket-tmp.gradle` sets the same system property for `Test` / `JavaExec` workers so test subprocesses do not fall back to the default `TEMP`. That directory must exist; other machines should point at their own writable directory and keep their existing JVM arguments. No project source and no global `TEMP` change is needed.

Maven coordinates: `io.github.steve02081504:fount-p2p:<version>` (the version is read from `../js/package.json`).

## Directory ↔ package mapping

The Kotlin package root is `io.github.steve02081504.fountp2p`, mirroring the JS directories one to one:

| JS | Kotlin |
| --- | --- |
| `js/core/x.mjs` | `src/main/kotlin/.../core/X.kt` |
| `js/crypto/x.mjs` | `.../crypto/X.kt` |
| `js/schemas/x.mjs` | `.../schemas/X.kt` |
| `js/utils/x.mjs` | `.../utils/X.kt` |
| `js/wire/x.mjs` | `.../wire/X.kt` |
| `js/node/...` | `.../node/...` |
| `js/test/pure/x.test.mjs` | `src/test/kotlin/.../<pkg>/XTest.kt` |

File names use PascalCase; one `.mjs` maps to one `.kt` (same-directory related functionality may be merged, but prefer 1:1 for easy comparison).

## Conventions

- **JSON model:** `typealias JsonValue = Any?`; objects are `Map<String, Any?>` (built with `LinkedHashMap` so key order matches JS), arrays are `List<Any?>`, numbers are uniformly `Double` (equivalent to JS). Access through the `Json` object: `Json.str/obj/arr/bool/num/long/int/at`; serialize with `Json.parse`, `Json.stringify`, `canonicalStringify` (= `core.canonicalStringify`). `JsonUndefined` is the `undefined` sentinel (object keys are skipped, array elements serialize to `null`).
- **JS number / JSON semantics:** `Json.jsNumberToString` reproduces ECMAScript `Number::toString` exactly (e.g. `1.0→"1"`, `1e21→"1e+21"`). Any JSON that participates in hashing / signing must go through that path.
- **Parse results:** wire / ingress parse functions return `Map<String, Any?>?` (preserving JS key order) and `null` when invalid; functions that throw on validation failure keep the message text identical (e.g. `"p2p: invalid hex"`).
- **Async:** I/O (files, network) uses `suspend`; pure computation (crypto, schema validation) stays synchronous. Concurrency uses `kotlinx.coroutines`; tests use `runBlocking`.
- **crypto:** Ed25519/X25519 via BouncyCastle (`bcprov-jdk18on`), SHA/HMAC/AES-GCM via JCA. Platform-incompatible equivalents of `node:crypto` are forbidden; Android compatibility comes first.
- **Error messages:** keep them as close to the JS text as possible so the paired tests can compare.
- **Comments / docs:** keep the JS KDoc/Chinese explanations; do not write meaningless comments.
- **JSONL read-modify-write:** `rewriteJsonlKeeping` / `appendJsonlSynced` / `writeJsonlSynced` take the shared `jsonlMutexKey` lock themselves and are **not reentrant** — never call them while already holding the same key (use the lock-free `writeJsonl` / `writeJsonlLines` instead). Rewrites preserve the original raw line (a `sanitize` passed to `rewriteJsonlKeeping` / `readJsonlEntries` only affects the value handed to the predicate) and skip the rename when nothing is dropped.
- **Do not commit:** subagents only change code; the main flow commits.

## Porting flow (per module)

1. Read `js/<module>/*.mjs` and the matching `js/test/pure/*.test.mjs`.
2. Write the Kotlin equivalent (keep function-name semantics and behavior).
3. **Write one Kotlin equivalent test per JS test** (`@Test` method names may drop illegal `.` `/` characters).
4. Get `.\gradlew.bat test --offline` green.
5. Record behavioral differences (when a deviation from JS is unavoidable, write it in the file-header KDoc).

## Platform abstraction conventions (network layer)

Android/JVM has no `ws` / WebRTC / `node:dgram` runtimes, so platform capabilities are always provided through **injected interfaces** (under `.../fountp2p/transport/` or inside each provider package):

- `WebSocketProvider` (nostr relay), `TcpDialer` / `UdpSocket` (LAN), `RtcProvider` (WebRTC), `BluetoothProvider` (BLE), `LanInterfaceProvider` (local interface enumeration).
- The library implements protocols / state machines / pure logic only; interface defaults may throw `UnsupportedOperationException`, tests use fakes, and the Android app injects the real implementation (OkHttp / system APIs / native WebRTC libraries).
- Every interface should have a JVM reference implementation (OkHttp 4.12 is cached: WebSocket + TCP; UDP uses `DatagramChannel`).

## Done (every JS module is ported 1:1)

- L0: `core/`, `utils/`, `crypto/`, `schemas/`
- `dag/`, `registries/`, `wire/`, `trust_graph/` (including build/cache/send), `reputation/`,
  `permissions/`, `federation/`, `governance/`, `mailbox/` (including deliver_or_store),
  `node/` (including identity, reputation_sync), `timeline/`, `files/` (EVFS),
  `link/`, `discovery/`, `transport/` (including link_registry, rooms, node_scope),
  `overlay/`, `infra/`
- Facade: `FountP2p.kt` (`startNode` + the `FountP2p` aggregate entry point)
- 533 tests, all green (`.\gradlew.bat test --offline`).

## Platform-specific (Android must inject)

The following capabilities are abstracted behind interfaces with only protocols / state machines inside the library; the JVM side provides `LanInterfaceProvider` (`java.net`), DNS and a NIP-11 HTTP reference implementation, the rest must be injected by the host:

- `discovery.nostr.WebSocketProvider` (relay WS), `link.providers.TcpDialer` (LAN TCP), `discovery.UdpSocketProvider` (LAN multicast), `link.rtc.RtcProvider` (WebRTC), `discovery.bt.BluetoothProvider` (BLE; the `BleGatt` accept / `ensureListening` paths must be completed by the host).
- BIP340 Schnorr is implemented in-library (`crypto/Schnorr.kt`, with vectors generated by noble); nostr event signing / publishing (`signNostrEvent` / `publishEvent` in `discovery/nostr/Event.kt`) and the provider's `sendNodeSignal` / `listenNodeSignals` / `startPresence` / `startGroupPresence` are wired back in.

## Still deferred / not covered

- `js/sim/` (the dev-only tunables co-evolution harness) is not ported.
- `js/test/live/**` (real network / two-machine) and `js/test/fount/**` (Deno cross-repo bridge) are not ported; their equivalent assertions are covered by fake providers in the pure tests wherever possible.
- A few JS cases that depend on real media or cold-start budgets (`startup_budget` etc.) are not ported.
- The adhoc relay subscription of nostr `connectToNode` (JS `ensurePeerRelaySubscriptions`) is not wired back; the `extraSubs` container is in place and `dispose` cleans it up.
