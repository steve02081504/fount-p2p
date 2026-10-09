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

### Proving a regression test catches its bug

A test written after a fix silently passes on the broken code more often than it looks. Run `node js/scripts/check-regression-guard.mjs --revert <fixed file> --tests <test file> --base <commit before the fix>` and it does the whole dance in a throwaway worktree: it copies the test file in, restores the fixed files from `--base` (default `HEAD~1`), runs the tests, and exits 0 only when every leaf case fails through its own assertion. A file that still passes, fails to load, or has cases that pass or get skipped is reported as not guarding (the counts are printed); always read *which* assertion failed — a test that only fails on an unrelated earlier assertion is not guarding anything.

The manual version of that flow, if you ever need it: `git worktree add --detach <dir> HEAD`, copy the new test files in, revert the fixed files with `git restore --source=<base> -- <path>` (never `git checkout <commit> -- <path>`, which also rewrites the working tree), point `js/node_modules` at the main checkout with a junction, run the suite, then delete the junction *before* `git worktree remove --force`: git follows the link and empties the real `js/node_modules` (observed here).

## Docs language

Every `AGENTS.md` and each `.md` reachable from it through local links is written in English (a non-`AGENTS.md` doc in that closure lives under a `docs/` directory), and source JSDoc summaries are Chinese. Both rules are enforced by the static checks described in [js/AGENTS.md](js/AGENTS.md); run `cd js; npm run test:checks`.
