# fount-p2p Kotlin 移植指南

本目录是 `js/`（`@steve02081504/fount-p2p`）的 Kotlin/JVM 等价实现，
目标产物是可用 Maven 依赖的 Android/JVM 库。

## 构建 / 测试

本机需使用 JDK 17–21（推荐 Android Studio 自带 JBR = 21）与 `GRADLE_USER_HOME=E:\Gradle`
（缓存了 Kotlin 2.2.10 插件、BouncyCastle、Gson、coroutines、JUnit4；离线可构建）。

```powershell
$env:GRADLE_USER_HOME = 'E:\Gradle'
$env:JAVA_HOME = 'E:\Android Studio\jbr'
.\gradlew.bat test --offline --console=plain                 # 全部测试
.\gradlew.bat test --offline --console=plain --tests 'io.github.steve02081504.fountp2p.core.*'
.\gradlew.bat compileKotlin --offline --console=plain        # 仅编译主源码
```

Maven 坐标：`io.github.steve02081504:fount-p2p:<version>`（version 自动读取 `../js/package.json`）。

## 目录 ↔ 包映射

Kotlin 包根为 `io.github.steve02081504.fountp2p`，与 JS 目录一一对应：

| JS | Kotlin |
|---|---|
| `js/core/x.mjs` | `src/main/kotlin/.../core/X.kt` |
| `js/crypto/x.mjs` | `.../crypto/X.kt` |
| `js/schemas/x.mjs` | `.../schemas/X.kt` |
| `js/utils/x.mjs` | `.../utils/X.kt` |
| `js/wire/x.mjs` | `.../wire/X.kt` |
| `js/node/...` | `.../node/...` |
| `js/test/pure/x.test.mjs` | `src/test/kotlin/.../<pkg>/XTest.kt` |

文件名用 PascalCase；一个 `.mjs` 对应一个 `.kt`（同目录同类功能可合并，但优先 1:1 便于对照）。

## 约定

- **JSON 模型**：`typealias JsonValue = Any?`，对象是 `Map<String, Any?>`（构造时用
  `LinkedHashMap` 保证键序与 JS 一致），数组是 `List<Any?>`。数字统一为 `Double`（等价 JS）。
  用 `Json` 对象访问：`Json.str/obj/arr/bool/num/long/int/at`；用 `Json.parse`、
  `Json.stringify`、`canonicalStringify`（= `core.canonicalStringify`）序列化。
  `JsonUndefined` 是 `undefined` 哨兵（对象键被跳过、数组元素序列化为 `null`）。
- **JS 数字/JSON 语义**：`Json.jsNumberToString` 精确复刻 ECMAScript `Number::toString`
  （如 `1.0→"1"`、`1e21→"1e+21"`）。任何参与哈希/签名的 JSON 必须走该路径。
- **解析结果**：wire/入站解析函数返回 `Map<String, Any?>?`（保持 JS 键序），非法返回 `null`；
  校验失败抛异常的函数保持消息文本一致（如 `"p2p: invalid hex"`）。
- **异步**：I/O（文件、网络）用 `suspend`；纯计算（crypto、schema 校验）保持同步。
  并发用 `kotlinx.coroutines`；测试用 `runBlocking`。
- **crypto**：Ed25519/X25519 用 BouncyCastle（`bcprov-jdk18on`），SHA/HMAC/AES-GCM 用 JCA。
  禁止 `node:crypto` 等价物的平台不兼容 API；Android 兼容性优先。
- **错误信息**：尽量与 JS 原文一致，便于对照测试。
- **注释/文档**：保留 JS 的 KDoc/中文说明；不要写无意义注释。
- **不要提交**：subagent 只改代码，由主流程统一提交。

## 移植流程（每个模块）

1. 读 `js/<module>/*.mjs` 与对应 `js/test/pure/*.test.mjs`。
2. 写 Kotlin 等价实现（保持函数名语义与行为）。
3. **为每个 JS 测试写一个 Kotlin 等价测试**（`@Test` 方法名可去掉非法字符 `.` `/`）。
4. `.\gradlew.bat test --offline` 跑通。
5. 记录行为差异（若不得不偏离 JS，写在文件头 KDoc 里）。

## 已完成的层

- L0 `core/`、`utils/`（除 fetch_wait 已实现）、`crypto/`、`schemas/`；`dag/Dag.kt`
  （merkleRoot / eventBodyForSign / computeEventId / topologicalCanonicalOrder 等）。

## 待移植

`wire/`、`node/`、`discovery/`、`link/`、`transport/`、`trust_graph/`、`mailbox/`、
`dag/`（canonicalize_row / strip_extensions / storage 等）、`federation/`、`files/`、
`governance/`、`reputation/`、`permissions/`、`registries/`、`overlay/`、`timeline/`、
`infra/`，以及 `index.mjs` 门面。

**平台相关模块**（`discovery/bt`、LAN/WiFi、WebRTC、`ws` relay）：Android 端以接口/`expect-actual`
抽象，JVM 侧用 OkHttp（已缓存）等实现；先保证纯逻辑与协议层可测。
