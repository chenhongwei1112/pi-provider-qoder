# Qoder 官方实现对齐审计 — 设计

日期：2026-08-16
状态：**待用户批准**（设计已呈现，尚未取得批准；批准后才进入 writing-plans）

## 1. 背景

`omp-provider-qoder` 是对 Qoder API 的第三方实现。最近几个提交（`3042f14`、`e46115e`、`80d92bf`、`8c50899`）都在修"没有和官方对齐"的问题，但每次修正依据的是对反编译代码的**文本阅读与推测**，缺少可验证的基准。`8c50899` 就是一个反例：它以"反编译实证"为由把模型目录端点从 `/algo/api/v2/model/list?Encode=1` 改成 `/api/v2/model/list`，同时删掉了 `/algo` 前缀和 `Encode=1`，而实测证明这两者官方都保留。

根本原因不是粗心，而是**缺少 ground truth**。官方客户端的签名、URL 构造、请求头全集与顺序、请求体编码全部在一个 Rust WASM 模块里，读 JS 读不出来。

驱动这次工作的是预防性动机：担心服务端把这个客户端识别为非官方实现，或者因为字段缺失而静默走降级路径。

## 2. 目标与非目标

### 目标

产出一份逐条可验证的差异台账，每条给出「官方行为 / 插件行为 / 证据位置 / 风险级 / 判定」。同时留下一套可复现的取证与比对工具，使今后任何签名层改动都有回归网。

**第一阶段不修改插件的运行时代码。**

### 非目标

- 不做性能优化，不做与对齐无关的重构。
- 不把官方 WASM 变成插件的运行时依赖（见 §10 的退路 B）。
- 不把官方代码或其派生产物提交进仓库。

## 3. 取证方法（已验证）

`qodercli` 1.1.23 是 Bun 编译的单文件可执行（129 MB ELF，未 strip）。以下常量与步骤均已实测通过，实现时不必重新摸索：

1. 从文件尾部反向搜索 magic `\n---- Bun! ----\n`，记其起始位置为 `end`（magic 之后还有 ELF section header，magic 不在文件末尾）。
2. `end - 32` 处读 `byte_count`(u64 LE) = 39 897 062；`end - 24` 处读 `modules_ptr` = (offset 39 894 342, length 2704)。
3. blob 基址 = `end - byte_count - 22`。那 22 字节是对齐补偿，必须减掉，否则所有 StringPointer 偏移都错位。
4. 模块表：52 字节/项，共 52 项（末项是 offsets 结构自身，实际模块 51 个）。项内 `name` StringPointer 在 +20，`contents` StringPointer 在 +28。
5. 主 bundle 是 blob 偏移 22 到第一个模块名起始处（16 838 172），共 16 838 150 字节。**末尾有一个 NUL 字节必须 truncate**，否则 esbuild 报 `Unexpected "\x00"`。
6. 重排版用 `esbuild bundle.js --format=esm --platform=node --target=node22`，得到 325 082 行可 grep 的代码。（biome 会因默认 1 MB 文件上限静默跳过，即使调高 `files.maxSize` 也仍然拒绝，不要用它。）

抽取脚本必须断言解析结果——模块数、shebang、wasm magic、bundle 尾部语法完整——失败即报错，绝不产出半成品。**版本升级后上述偏移可能变化**，断言是唯一的保护。

### 抽出的关键产物

| 产物 | 大小 | 用途 |
| --- | --- | --- |
| 主 bundle（重排版） | 20 MB / 325 082 行 | JS 层逻辑：SSE 解析、目录解析、认证编排 |
| `qoder_auth_wasm_bg.wasm` | 297 238 B | 签名/URL/请求头/请求体编码的唯一权威 |
| `chat.proto` | 8 334 B | `model.chat` 权威 schema，请求体字段的基准 |
| 内置资源 51 项 | — | `SKILL-*.md`、sandbox profile、`rg`、libvips 等 |

WASM 以 base64 内联在 bundle 里（`pretty.mjs:413` 的 `ZeB`），不需要额外下载。它导出 34 个符号，与对齐相关的是：

```
qodercontext_new / qodercontext_prepareRequest / qodercontext_prepareInferRequest
qodercontext_refreshAuthFields / generate_runtime_auth_fields
requestresult_url / requestresult_headers / requestresult_headerCount
decrypt_server_response / model_cache_encrypt / model_cache_decrypt
credential_storage_encrypt / credential_storage_decrypt
build_httpdns_url / get_httpdns_account_id / get_httpdns_secret_key
```

## 4. 架构

三个互相独立、边界清晰的组件：

### `scripts/extract-qodercli.ts`

输入 `~/.qoder/bin/qodercli/qodercli-<ver>`，输出 `.qoder-audit/<ver>/` 下的 `bundle.js`、`pretty.mjs`、`chat.proto`、`qoder_auth_wasm_bg.wasm`、`modules.json`。纯粹的解包，不含任何 Qoder 语义。`.qoder-audit/` 加入 `.gitignore`。

### `scripts/cosy-oracle.ts`

从 `pretty.mjs` 切出 wasm-bindgen glue，加载 WASM，对固定输入集调 `prepareRequest` / `prepareInferRequest`，取出完整的 URL、请求头（含顺序）、编码后的 body，再跑一遍插件的 `buildAuthHeaders` / `qoder-encoding`，输出逐字段 diff。

glue 的切法已验证：取重排版 bundle 的第 1–40 行（运行时 helper，需把 `WA = import.meta.require` 换成 `createRequire`）加第 366–1066 行（环境常量、`getClientMetadata`、wasm glue、`QoderContext` 包装、`prepareWasmAuthenticatedRequest`），再补一段 `export`。这样切出来的模块**在 node 22 下可直接运行**，不需要 bun，也不引入 `undici` 等 bun 内置依赖。

固定输入集覆盖：auth 类 GET（`model/list`）、infer-sse POST（chat）、空 body、大 body、CN 模式。

### `docs/qoder-alignment-audit.md`

六面差异台账。每条一行，字段固定为「官方行为 / 插件行为 / 证据 / 风险级 / 判定」。

## 5. 方法论：oracle 优先，字符串推断不得作为结论

审计过程中，对 WASM 数据段做字符串搜索得出了两条结论，随后都被 oracle 实测推翻：

- 「`Cosy-Key`、`Cosy-Bodyhash`、`Cosy-Bodylength`、`Cosy-Sigpath` 在官方代码里命中数为 0，所以官方不发这些头」——`Cosy-Key` 官方确实发，只是探测时传入 `key: ""` 使其看起来是空值。
- 「数据段有 `Cosy-Data-Policyagree`，所以官方发 `agree`」——实测是 `disagree`，与插件一致。
- 「插件缺失 `X-Model-Key` / `X-Model-Source`」——错。它们在 `transport.ts:206-207` 里发，只看 `cosy.ts` 会漏。插件的请求头分散在两个文件，比对必须以最终 `fetch` 的合并结果为单位，不能按文件读。

因此本审计的硬规则：**凡属 WASM 覆盖范围（URL、请求头、签名、请求体编码、响应解密）的结论，必须由 oracle 实跑输出支撑；字符串搜索只用于定位，不用于定论。** JS 层可读的逻辑（SSE 事件语义、目录字段解析、认证编排）才允许以代码阅读为证据，且须标注行号。

## 6. 审计范围

六个面，每面的证据锚点已定位（行号指重排版 bundle）：

| 面 | 内容 | 证据锚点 |
| --- | --- | --- |
| 1 传输层指纹 | URL、请求头全集与顺序、签名、body 编码、UA、重试与超时 | WASM oracle；`69405-69462`（JS 层追加的 `Cosy-Version`/`ClientType`/`MachineOS`/`MachineHostname`）；`77012` |
| 2 请求体构造 | messages/tools 映射、`thinking_config`、`model_config`、`max_output_tokens`、`session_id`/`record_id`、system prompt 位置 | `chat.proto`；`249081`、`298125` |
| 3 响应流解析 | SSE 事件类型全集、reasoning 与 `<think>` 回退、工具调用分片组装、usage 映射、stop_reason、错误体 | bundle 内 SSE 解析段；`decrypt_server_response` |
| 4 模型目录与配额 | `model/list` 解析、`enable`/scene 过滤、efforts、上下文与图片能力、quota/usage | `105961`、`106048`、`117839-117860` |
| 5 认证与身份 | PAT→jobToken 交换、OAuth device flow、token 刷新时机、machineID/userID 来源与落盘 | `114977`、`115138`、`76192-76286` |
| 6 CN 版差异 | 端点、模型 key 映射、签名与头是否与全球版不同 | `77297`（端点动态发现） |

## 7. 判定与分级

**判定三态。** README 的 Fork notes 已经记录了三条由 omp 强制的差异，所以「有差异」不等于「要改」：

- **必须对齐** — 无阻碍，纯 bug。
- **不能对齐** — omp 架构或缺少官方私有输入导致，须写明原因。
- **无需对齐** — 差异不影响服务端观测或客户端行为。

**风险三级。**

- **高** — 可致封禁或风控降级（主要来自面 1）。
- **中** — 静默行为劣化：字段缺失导致服务端走 fallback，客户端看不到报错但质量下降（主要来自面 2、3）。
- **低** — 仅影响本地展示。

## 8. 已确认的差异（初始台账）

以下全部由 oracle 实测支撑，可直接进入台账。

### 已验证正确的部分

- 签名算法：`md5(payloadB64 \n cosyKey \n timestamp \n body \n sigPath)`，插件 `cosy.ts:300-311` 完全一致。
- `sigPath` 去 `/algo` 前缀、不含 query，插件 `computeSigPath`（`cosy.ts:228-235`）完全一致。
- Authorization payload 结构 `{version:"v1", requestId, info, cosyVersion, ideVersion:""}`，插件 `cosy.ts:286-292` 完全一致。
- chat URL 含 `?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`，插件 `cosy.ts:104` 完全一致。
- `Cosy-Data-Policy: disagree`，一致。
- infer 请求头 `X-Model-Key` / `X-Model-Source` / `Accept: text/event-stream` / `Cache-Control: no-cache` / `Content-Type: application/json`，插件 `transport.ts:201-209` 一致。

### 差异

| # | 项 | 官方 | 插件 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | `model/list` URL | `/algo/api/v2/model/list?Encode=1`，响应需 `decrypt_server_response` 解密 | `/api/v2/model/list`，前缀与 `Encode=1` 均被删（`8c50899` 回归） | 高 |
| 2 | `Cosy-Version` | `1.1.23`（取自 package 版本） | 硬编码 `1.1.3` | 高 |
| 3 | 请求头大小写 | `Cosy-MachineId` / `Cosy-MachineToken` / `Cosy-MachineType` / `Cosy-ClientType` | `Cosy-Machineid` / `Cosy-Machinetoken` / `Cosy-Machinetype` / `Cosy-Clienttype` | 高 |
| 4 | 业务标识头 | `Cosy-Business-Product: cli`、`Cosy-Business-Type: agent`、`Cosy-Scene: assistant` | 全部缺失 | 高 |
| 5 | 多发的头 | 不存在 | `Cosy-Bodyhash`、`Cosy-Bodylength`、`Cosy-Sigpath`、`X-Request-Id` | 高 |
| 6 | `Connection` | infer 带 `Connection: keep-alive` | 缺失（`transport.ts:201-209`） | 中 |
| 7 | `Cosy-ClientIp` | infer 不发；auth GET 发，值为 machineId | 两者都发，值恒为 `127.0.0.1` | 中 |
| 8 | `Accept-Encoding` | 仅 auth GET 带 `identity`，infer 不带 | infer 也带 `identity`（`transport.ts:205`） | 低 |
| 9 | `info` / `Cosy-Key` 来源 | 登录时服务端下发 `encrypt_user_info` 与 `key`，之后原样回放 | 本地 AES-CBC + RSA 现算（`cosy.ts:280-281`） | 中 |
| 10 | 端点解析 | `/api/v3\|v4/service/region/endpoints` 动态发现 + `/algo/api/v1/ping` 健康检查 | 硬编码 `api3.qoder.sh` / `gateway.qoder.com.cn` | 中 |
| 11 | body 编码 | 在 WASM 内完成（147 B JSON → 196 B） | TS 重实现 `qoder-encoding.ts`，等价性未验证 | 中 |

第 9 项是架构级差异，很可能落入「不能对齐」——插件没有官方登录响应里的那两个字段。审计需要确认服务端是否接受本地现算的值，以及这是否解释了任何已观测到的行为差异。

### 顺带确认的事实

`qodercli` 是 Gemini CLI 的 fork（bundle 里保留了 `GEMINI_CLI_*` 环境变量名），这提示面 3 的事件语义可能沿用 gemini-cli 的形状，审计时应据此定位。`getClientMetadata()` 的四个字段由 `QODER_CLIENT_TYPE` / `QODER_BUSINESS_PRODUCT` / `QODER_BUSINESS_TYPE` / `QODER_SCENE` 环境变量覆盖，默认 `5` / `cli` / `agent` / `assistant`。

## 9. 交付物与验证

**交付物**

- `scripts/extract-qodercli.ts`
- `scripts/cosy-oracle.ts`
- `docs/qoder-alignment-audit.md`
- `src/__tests__/cosy-oracle-vectors.test.ts` — 从 oracle 固化出的测试向量，使签名层今后有回归网

**验证方式**

- oracle 对固定输入集的 diff 输出必须可复现：同输入同输出。
- 台账里每条「必须对齐」的差异，都要能在 oracle diff 输出或 `chat.proto` 校验结果里指到具体一行。
- 抽取脚本对当前安装的 `qodercli-1.1.23` 跑通，且断言全部通过。
- 测试向量在没有本地 `qodercli` 安装时也能跑——固化的是数据而非对 WASM 的实时依赖。

## 10. 风险与退路

**glue 切不干净。** 已在 1.1.23 上验证可行，但版本升级后行号会变。退路：直接 `WebAssembly.Instance` 加手写 ABI 包装，只覆盖实际需要的 5 个导出（`qodercontext_new`、`prepareRequest`、`prepareInferRequest`、`requestresult_url`、`requestresult_headers`），成本更高但不依赖 bundle 结构。

**TS 实现无法等价。** 若某处（最可能是第 9 项或第 11 项）证明 TS 侧无法产出与 WASM 相同的输出，退路是运行时直接加载本地安装的 WASM。这条路签名必然一致，但会让插件硬依赖用户安装 qodercli，且 MIT 插件运行时依赖闭源 WASM 有授权顾虑——**只在 A 证明不可行后才考虑，且需用户单独批准**。

**审计范围膨胀。** 台账是唯一交付物，第一阶段不改代码。修复按风险级另起计划。

## 11. 阶段划分

- **第一阶段（本设计）** — 取证工具 + 六面台账 + 测试向量。不改运行时代码。
- **第二阶段** — 按台账的风险级与判定挑选修复项，逐条落地。每条修复都以第一阶段固化的测试向量为验收依据。
