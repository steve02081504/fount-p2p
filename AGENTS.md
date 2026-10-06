# fount-p2p monorepo

fount federated P2P layer. This repo ships two equivalent implementations:

| Directory | Language | Role |
|---|---|---|
| `js/` | JavaScript (ESM, Node ≥20) | Original implementation, `@steve02081504/fount-p2p` |
| `kotlin/` | Kotlin/JVM | Equivalent port published as the Maven package `io.github.steve02081504:fount-p2p` for the Android / fount mobile side |

The two implementations map one module to one module (`js/core/x.mjs` ↔ `kotlin/src/main/.../core/X.kt`), and every JS test has an equivalent Kotlin test.

## Build and test

### JS (`js/`)

```bash
cd js
npm install
npm test            # pure + integration + frontend
npm run test:live   # live link / LAN smoke (needs network)
```

### Kotlin (`kotlin/`)

Needs JDK 17–21 (Android Studio JBR recommended) and `GRADLE_USER_HOME=E:\Gradle` (offline dependencies are cached on this machine):

```powershell
cd kotlin
$env:GRADLE_USER_HOME = 'E:\Gradle'
$env:JAVA_HOME = 'E:\Android Studio\jbr'
.\gradlew.bat test --offline
```

Details: [kotlin/AGENTS.md](kotlin/AGENTS.md) and [js/AGENTS.md](js/AGENTS.md).

### Verifying one commit in isolation

`git worktree add` is handy for running a single commit's tests, but never leave a `node_modules` directory junction/symlink inside a worktree that `git worktree remove --force` will delete: git follows the link and empties the real `js/node_modules` (observed here). Delete the link first (`cmd /c rmdir <worktree>\js\node_modules`) or run `npm ci --prefer-offline` inside the worktree instead.

## Docs language

Every `AGENTS.md` and each `.md` reachable from it through local links is written in English (a non-`AGENTS.md` doc in that closure lives under a `docs/` directory), and source JSDoc summaries are Chinese. Both rules are enforced by the static checks described in [js/AGENTS.md](js/AGENTS.md); run `cd js; npm run test:checks`.
