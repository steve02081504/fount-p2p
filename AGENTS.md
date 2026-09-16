# fount-p2p monorepo

fount 联邦 P2P 层。本仓库同时包含两套等价实现：

| 目录 | 语言 | 说明 |
|---|---|---|
| `js/` | JavaScript (ESM, Node ≥20) | 原始实现 `@steve02081504/fount-p2p` |
| `kotlin/` | Kotlin/JVM | 等价移植，产出 Maven 包 `io.github.steve02081504:fount-p2p`，供 Android/fount 手机端使用 |

两套实现按模块一一对应（`js/core/x.mjs` ↔ `kotlin/src/main/.../core/X.kt`），
且每个 JS 测试在 Kotlin 侧都有等价测试。

## 构建与测试

### JS（`js/`）

```bash
cd js
npm install
npm test            # pure + integration + frontend
npm run test:live   # 实时 link / LAN smoke（需要网络）
```

### Kotlin（`kotlin/`）

需 JDK 17–21（推荐 Android Studio JBR）与 `GRADLE_USER_HOME=E:\Gradle`（本机已缓存离线依赖）：

```powershell
cd kotlin
$env:GRADLE_USER_HOME = 'E:\Gradle'
$env:JAVA_HOME = 'E:\Android Studio\jbr'
.\gradlew.bat test --offline
```

详见 [kotlin/AGENTS.md](kotlin/AGENTS.md) 与 [js/AGENTS.md](js/AGENTS.md)。
