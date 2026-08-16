# Qoder 官方实现对齐台账

基准：`qodercli` 1.1.23。方法与硬规则见
`docs/superpowers/specs/2026-08-16-qoder-official-alignment-audit-design.md`。

差异数据来自 `src/__tests__/fixtures/cosy-oracle-vectors.json`（由
`npm run audit:extract && npm run audit:freeze` 生成）。**改台账前先改向量。**

判定：必须对齐 / 不能对齐 / 无需对齐。风险：高（可致封禁或风控降级）/
中（静默行为劣化）/ 低（仅影响本地展示）。

## 证据记法

硬规则（spec §5）：凡属 WASM 覆盖范围（URL、请求头、签名、请求体编码、响应解密）的结论，
必须由 oracle 实跑或冻结向量支撑。本项目已有三条字符串推断被实测推翻，不要再加第四条。
JS 层可读的逻辑是唯一例外，且必须带行号。

| 记法 | 含义 | 强度 |
| --- | --- | --- |
| `V.<路径>` | `src/__tests__/fixtures/cosy-oracle-vectors.json` 的字段路径 | 官方 WASM 实跑冻结值 |
| `预言机:"<用例名>"` | `scripts/__tests__/cosy-oracle.test.mjs` 用例 | 官方 WASM 实跑（需本地 qodercli） |
| `锁定:"<用例名>"` | `src/__tests__/cosy-oracle-vectors.test.ts` 用例 | 向量 vs 插件的锁定比对 |
| `键集:"<用例名>"` | `src/__tests__/request-body.test.ts` 用例 | 插件请求体键集与键序 |
| `JS:<行>` | `.qoder-audit/1.1.23/pretty.mjs` 行号 | 官方 JS 层源码（允许，须带行号） |
| `proto:<行>` | `.qoder-audit/1.1.23/chat.proto` 行号 | **schema 声明，不等于官方实际发送** |
| `src/*:<行>` | 本仓库源码 | 插件行为 |

`.qoder-audit/` 不入库；本文件只引用实测值（头名、URL、哈希、行号），不摘录官方源码。

## 差异台账

### 面 1：传输层指纹

| # | 面 | 项 | 官方行为 | 插件行为 | 证据 | 风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | `model/list` URL | `https://api3.qoder.sh/algo/api/v2/model/list?Encode=1` | ~~`/algo` 前缀与 `Encode=1` 都被删（`8c50899` 回归），注释还把错误行为标成"反编译实证"~~ **已修**：`cosy.ts:95-101` 恢复官方 URL，那条假出处的注释换成了指向冻结向量的说明，`cosy.test.ts` 两条红灯用例转绿，另加一条 `锁定:"matches the official model catalog URL"` 直接对 `V.catalogRequest.url` 断言，杜绝再次"改源码顺手改断言" | `V.catalogRequest.url`；`预言机:"adds the /algo prefix and keeps Encode=1 on the model catalog request"`；`src/cosy.ts:95-101`。`src/__tests__/cosy.test.ts:92-100` 两条红用例断言的是**正确**值，修 `cosy.ts` 即转绿 | 高 | 必须对齐 |
| 2 | 1 | `Cosy-Version` 与签名载荷 `cosyVersion` | 均为 `1.1.23`，取 package 版本（`JS:69503` `CUH = P9A \|\| "1.1.23"`） | ~~均硬编码 `1.1.3`，一个常量喂请求头与签名载荷两处~~ **已修**：`cosy.ts:17` 升到 `1.1.23`，请求头与被签名载荷同时对上，`锁定:"sends the same Cosy-Version as the official client, in the header and in the signed payload"` 两处都断言 | `V.inferRequest.headers["Cosy-Version"]`、`V.signature.payload.cosyVersion`；`锁定:"still pins a stale Cosy-Version"` | 高 | 必须对齐 |
| 3 | 1 | WASM 头大小写 | `Cosy-MachineId` / `Cosy-MachineToken` / `Cosy-MachineType` / `Cosy-ClientType` | ~~`Cosy-Machineid` / `Cosy-Machinetoken` / `Cosy-Machinetype` / `Cosy-Clienttype`~~ **已修**：四个头名改成官方拼法（`cosy.ts:346-350`） | `锁定:"still spells these headers with different casing than the official client"` | 高 | 必须对齐 |
| 4 | 1 | `Cosy-MachineOS` 大小写 | 官方**在 JS 层**注入，不在 WASM 里：`JS:69460` 用大小写无关的"不存在才写"helper（`JS:69431`）写入 `JS:69487` 的常量 `x86_64_linux`；model-list（`JS:105910`）与 infer-sse（`JS:146170`）都传 `injectClientIdentityHeaders: !isServiceAccount()`，普通用户为 true | ~~`Cosy-Machineos`~~ **已修**：改成 `Cosy-MachineOS`（`cosy.ts:349`），值的计算方式本来就一致 | `V.inferRequest.headerNames`（含 `Cosy-MachineOS`，由 `scripts/freeze-vectors.mjs:36` 按上述行号合并进来）；`锁定:"still spells these headers with different casing than the official client"` | 高 | 必须对齐 |
| 5 | 1 | 业务标识头缺失 | `Cosy-Business-Product: cli`、`Cosy-Business-Type: agent`、`Cosy-Scene: assistant`（两类请求都发） | ~~三个都不发~~ **已修**：补上 `cli` / `agent` / `assistant` 三个头（常量 `cosy.ts:24-26`，写在 `cosy.ts:351-353`），取值即官方 `getClientMetadata()` 的默认值 | `V.inferRequest.headers`、`V.catalogRequest.headers`；`锁定:"still misses exactly these official headers"`；`预言机:"emits the business identity headers on the infer request"` | 高 | 必须对齐 |
| 6 | 1 | `Connection` | infer 带 `Connection: keep-alive` | ~~不发~~ **已修**：`transport.ts:207` 在 infer 请求上发 `Connection: keep-alive` | `V.inferRequest.headers.Connection`；`锁定:"still misses exactly these official headers"` | 中 | 必须对齐 |
| 7 | 1 | 多发签名辅助头 | 两类请求都不发 `Cosy-Bodyhash` / `Cosy-Bodylength` / `Cosy-Sigpath` | ~~三个都发，把签名的中间量摊在明文头里~~ **已修**：三个头连同 `bodyHash` / `bodyLen` 的计算一起删掉（`cosy.ts:334-360`） | `V.inferRequest.headerNames`、`V.catalogRequest.headerNames` 均无；`锁定:"still sends exactly these headers the official client does not"` | 高 | 必须对齐 |
| 8 | 1 | 多发空值组织头 | **有组织时发、无组织时不发**：`Cosy-Organization-Id` 取 user-info 的 `organization_id`，`Cosy-Organization-Tags` 把 `organization_tags` 用 `,` 连接（预言机实测，见插件列） | ~~恒发两个空字符串~~ **已修，且本行的官方结论已修正**：先前写"官方不发这两个头"是取证身份不完整导致的误判 —— 早期只给 WASM 喂了 `{uid, encrypt_user_info, key}` 三段 user-info，而官方交给 `createContext` 的是六段（`JS:114847`）。补上组织字段后实测（`预言机:"sends both organization headers when the credential has one, joining tags with a comma"`）：**官方确实发这两个头**，tags 用 `,` 连接；没有组织时才完全不发。所以正确终态不是"删掉"，而是"有组织数据时才发" —— 现已按此实现，值来自 `/api/v1/userinfo`（第 49 行） | `V.inferRequest.headerNames`、`V.catalogRequest.headerNames` 均无；`锁定:"still sends exactly these headers the official client does not"` | 中 | 必须对齐 |
| 9 | 1 | 多发 `X-Request-Id` | 只在 `endpointType === "openapi"` 或 host 含 `openapi` 时写 `X-Request-ID`（`JS:68585`、`JS:68592`、`JS:68607-68610`，头名常量 `JS:68612`）。`api3.qoder.sh` 上的 model-list 与 infer 都是 `endpointType: "infer"`，两者都不写 | ~~恒发 `X-Request-Id`，大小写也与官方的 `X-Request-ID` 不同~~ **已修**：删掉了。官方只在 openapi 类请求上发它，插件没有那类请求 | `V.inferRequest.headerNames`、`V.catalogRequest.headerNames` 均无；`锁定:"still sends exactly these headers the official client does not"` | 中 | 必须对齐 |
| 10 | 1 | `Cosy-ClientIp` | **按请求类不同**：auth GET 发，值等于 machineId；infer 不发 | ~~两类都发，值恒为 `127.0.0.1`~~ **已修**：改成只在 auth 类发、值取 machineId，与官方一致（`cosy.ts` 的 `requestClass === "auth"` 分支）。`锁定:"keeps Cosy-ClientIp and Accept-Encoding on the auth class only"` 双向断言 | `V.catalogRequest.headers["Cosy-ClientIp"]` = machineId；`V.inferRequest.headerNames` 无此项；`预言机:"emits the business identity headers on the infer request"` 显式断言 infer 上为 undefined；`锁定:"still sends exactly these headers the official client does not"` | 中 | 必须对齐 |
| 11 | 1 | `Accept-Encoding` | **按请求类不同**：auth GET 带 `identity`，infer 不带 | ~~正好反了：infer 带、model-list 不带~~ **已修**：改成只在 auth 类发 `identity`，infer 不发 | `V.catalogRequest.headers["Accept-Encoding"]` = `identity`；`V.inferRequest.headerNames` 无此项；`锁定:"still sends exactly these headers the official client does not"` | 低 | 必须对齐 |
| 12 | 1 | auth GET 的 `Content-Type` | 即使是无体 GET 也带 `Content-Type: application/json` | ~~model-list 不带；且该差异不在锁定套件里——锁定套件只比 infer 类~~ **已修**：`models.ts` 的 fetch 现在带 `Content-Type: application/json`，**并且锁定套件已改成两个请求类都比**，这类"只比一半"的漏洞不会再有 | `V.catalogRequest.headers["Content-Type"]` | 低 | 必须对齐 |
| 13 | 1 | `Cosy-MachineHostname` | 仅 `requestClass === "infer-sse"` 时发（`JS:69460-69462`），且主机名必须 header-safe：不安全时 `JS:69407`→`JS:69383` 会规范化甚至省略并打 warn | ~~从不发~~ **已修**：infer 请求在主机名 header-safe 时发它，规范化规则照官方 `pretty.mjs:69383-69398` 复刻（`cosy.ts` 的 `normalizeMachineHostname`），七条用例覆盖原样透传 / 去空白 / punycode / 不安全字符压成 slug+sha256 前 8 位 / 全不安全时 `unknown-<hash>` / 96 字符截断 / 空值不发头 | `JS:69460-69462`、`JS:69407`、`JS:69383-69386`；**故意不冻结进向量**（值随机器变化，冻结会让测试在别的机器上红，见 `scripts/freeze-vectors.mjs:23-34`） | 中 | 必须对齐 |
| 14 | 1 | `info` / `Cosy-Key` 来源 | **本地生成，不是服务端下发。**Task 7 写的"登录响应下发、客户端原样回放"是推断，本轮实测推翻：三条登录路径都先把 `encrypt_user_info` 与 `key` 置成空串（PAT `JS:114651`、device token `JS:114939`、外部 job token `JS:115056`），随后 `regenerateRuntimeFields()`（`JS:114927-114931`）调 WASM 导出 `generate_runtime_auth_fields`，喂 `{uid, organization_id, organization_tags, data_policy_agreed}`，拿回的就是这两个字段；再灌进 QoderContext（`JS:114891-114892`）由它原样回放。两者不入库（`JS:234481` 持久化前剥掉），每次 token 刷新重算（`JS:115126-115128`、`JS:115145-115147`） | ~~本地现算，明文塞 `{uid, security_oauth_token, name, aid, email}`~~ **已修**：明文改成官方那四个字段 `{uid, organization_id, organization_tags, data_policy_agreed}`（`cosy.ts` 的 `UserInfo` 与 `runtimeAuthFields`），token / name / email 都不再进加密载荷。加密方式仍是本地 AES-CBC + RSA —— 官方也是本地算，只是走 WASM 导出，两边都不依赖服务端下发。**已用真实网关验证**：`model/list` 200、`agent_chat_generation` 200 且正常流式，服务端接受了新明文 | `预言机:"replays the credential-supplied user info and key verbatim"`（只证 QoderContext 原样回放，不证来源）；`JS:114927-114931`、`JS:114651`、`JS:114939`、`JS:115056`、`JS:234481`。`预言机:"derives encrypt_user_info and key locally from the user info object"` 与 `预言机:"produces a different pair on every call for the same input"`（两条常驻用例，见下方面 5 说明）；实测结论：输出恰为 `{encrypt_user_info, key}` 两键；`key` 恒 172 个 base64 字符 = 128 字节 = RSA-1024 密文，与 `cosy.ts:7-12` 那把 1024 位公钥同宽；`encrypt_user_info` 的长度恒等于 PKCS7(输入 JSON 字节数)——86→128、102→152、118→172、175→236 个 base64 字符，即 **WASM 原样加密 JS 交给它的 JSON，不筛字段也不重塑**；同一输入连调两次密文不同（每次换随机 key/IV） | 中 | **必须对齐。**面 5 已证插件拿得到官方放进去的每一项：`uid` 来自 `/api/v1/userinfo`（`pat.ts:124`），`organization_id` / `organization_tags` 就在同一个响应里、官方也是从那儿取的（`JS:115002`），只是 `pat.ts:118-126` 没读（见差异第 49 行）；`data_policy_agreed` 是本地设置（插件已有 `Cosy-Data-Policy`，`cosy.ts:18`）。**没有任何阻碍，所以不是"不能对齐"。**要改两处：明文换成官方那四个键（别再把 bearer token 塞进 `info`），以及每凭据算一次而不是每请求算一次（见差异第 50 行） |
| 15 | 1 | 端点解析 | ~~动态发现~~ **已实测：该服务已下线。**2026-08-16 对 `/api/v3` 与 `/api/v4` 的 `service/region/endpoints` 在 `api3`/`api2-v2`/`openapi` 三个 host × 是否带 `/algo` 前缀 × 是否带 `Authorization` 共八组合全部 404；bundle 里 `MWQ.prod` 的 `api2-v2.qoder.sh`（`JS:136971`）连 `/algo/api/v1/ping` 都 404，整个 host 已死 | ~~硬编码 `api3.qoder.sh`~~ **维持硬编码**：发现依赖的服务端已不存在，硬编码是当前唯一可行来源。实测两个活 region 从取证机延迟实质相同（api2 45.2ms / api3 43.7ms），硬编码 api3 不构成性能损失 | `JS:77297`（路径）、`JS:136971`（已死的 prod host）；`scripts/live-alignment-check.ts` 的发现步骤现为信息性监控 | 中 → 低 | ~~必须对齐~~ **无需对齐（实测改判）**。官方做发现是为了 region 亲和与故障转移，但服务端发现端点已下线，无从对齐。哪天它返回 200 再重估 |

#### 面 1 未覆盖

以下属面 1 范围但本轮**没有**取到可下结论的证据，不要当成"已对齐"：

- **`User-Agent`**。两侧的头集里都没有显式 `User-Agent`（`V.catalogRequest.headerNames`、`V.inferRequest.headerNames`、`cosy.ts:287-356`、`transport.ts:201-209`），所以实际发出去的是运行时默认值——官方是 Bun 的，插件是 Node/undici 的。这是真实差异，但它在 WASM 与插件代码之外，oracle 测不到，需要抓包才能定论。
- **重试与超时策略**。官方按 requestClass 表驱动（`JS:68695` 的 contract 表：maxAttempts / connectTimeoutMs / responseHeadersTimeoutMs / bodyIdleTimeoutMs / retryableStatuses …）；`transport.ts:4` 的注释声称已镜像 `infer-sse` 这一档，但未逐字段核对过。
- **OTel 传播头**。官方每个请求都过 `nY`（`JS:69465` 调用，定义在 `JS:32517`），在有活跃且有效的 span context 时（`JS:32513`）注入 `traceparent` 等标准头；是否有活跃 span 取决于官方遥测的运行时开关，代码读不出来，故不列为差异行。插件从不发这类头。

### 面 2：请求体构造

**先划清两个"官方"。** `chat.proto`（package `model.chat`、`service ChatService`，`proto:313-321`）是网关**下游**的模型侧 schema，不是插件所打的
`/algo/api/v2/service/pro/sse/agent_chat_generation` 的线上格式。凡只有 proto 支撑的行，措辞一律是
"官方 schema 声明"，不是"官方客户端发送"。

官方客户端实际发出的 gateway body 的构造点是 `JS:132123`（顶层）、`JS:132178`（`chat_context`）、
`JS:132131`（`model_config`）、`JS:121989-122005` + `JS:132110-132121`（`parameters`）、
`JS:111965-112006`（assistant 消息）、`JS:102851-102869`（prompt cache 断点）。这些是 JS 层可读逻辑，
按硬规则允许作为证据，行号已标。

WASM 对 body 只做整体混淆编码，不校验、不重塑（见「已验证一致」第 1 条），所以面 2 全部落在 JS 层，
`src/__tests__/request-body.test.ts` 钉住的键集就是插件在这一面的全部贡献。

官方顶层键序（`JS:132123`，`patches` 与 `business` 是条件键）：
`request_id, request_set_id, chat_record_id, session_id, stream, chat_task, chat_context, is_reply, is_retry,
source, version, agent_id, task_id, session_type, aliyun_user_type, model_config, custom_model, system,
messages, tools, parameters, [patches], [business]`

插件顶层键序（`request.ts:175-225`，`键集:"sends exactly these top-level keys, in this order"`）：
`request_id, request_set_id, chat_record_id, session_id, stream, chat_task, is_reply, is_retry, source,
version, session_type, agent_id, task_id, code_language, chat_prompt, image_urls, aliyun_user_type, system,
messages, tools, parameters, chat_context, model_config, business`

`ChatCompletionRequest` 声明的 24 个字段（`proto:26-51`）及其在 gateway body 里的承载：

| proto 字段 | 类型 | 官方 gateway body 承载 | 插件承载 |
| --- | --- | --- | --- |
| `model` = 1 | `string` | `model_config.key` | `model_config.key` + `chat_context.extra.modelConfig.key` |
| `messages` = 2 | `repeated ChatMessage` | `messages` | `messages` |
| `temperature` = 3 | `DoubleValue` | `parameters.temperature`（仅用户配置时） | 无 |
| `top_p` = 4 | `DoubleValue` | `parameters.top_p`（同上） | 无 |
| `max_tokens` = 5 | `Int32Value` | `parameters.max_tokens`（恒发） | `parameters.max_tokens`（恒发） |
| `stream` = 6 | `bool` | `stream: true` | `stream: true` |
| `stop` = 7 | `repeated string` | 无 | 无 |
| `presence_penalty` = 8 | `DoubleValue` | 无 | 无 |
| `frequency_penalty` = 9 | `DoubleValue` | 无 | 无 |
| `n` = 10 | `Int32Value` | 无 | 无 |
| `user` = 11 | `StringValue` | 无（身份走 `Cosy-User` 头） | 无（同） |
| `seed` = 12 | `Int32Value` | 无 | 无 |
| `reasoning` = 13 | `Reasoning{effort}` | `parameters.reasoning_effort` / `enable_thinking` / `reasoning_budget_tokens` | `model_config.thinking_config.*.is_default` + `chat_context.extra.modelConfig.thinking_effort` |
| `parallel_tool_calls` = 14 | `BoolValue` | 无 | 无 |
| `logit_bias` = 15 | `map<string,double>` | 无 | 无 |
| `tools` = 16 | `repeated Tool` | `tools` | `tools` |
| `tool_choice` = 17 | `Value` | `parameters.tool_choice`（仅调用方指定时） | 无 |
| `response_format` = 18 | `ResponseFormat` | 无 | 无 |
| `modalities` = 19 | `repeated string` | 无 | 无 |
| `stream_options` = 20 | `StreamOptions{include_usage}` | 无 | 无 |
| `patches` = 21 | `map<string,ChatPatchList>` | `patches`（仅非空时） | 无 |
| `metadata` = 22 | `ChatMetadata` | 拆平：`business` + 顶层 `request_id`/`request_set_id`/`session_id`/`task_id` | 同，但无 workspace / user |
| `extras` = 23 | `Struct` | 无 | 无 |
| `custom_model` = 24 | `CustomModelConfig` | `custom_model`（非 BYOK 时为 `undefined`，`JSON.stringify` 丢掉） | 无（等效） |

`proto` 里另有 `parameters` 侧的 `top_k` / `context_length` / `preserve_thinking` 没有对应顶层字段
（`JS:121989-122005`、`JS:132120`），说明 gateway 的 `parameters` 与 proto 顶层不是一一映射，网关自己做转换。

| # | 面 | 项 | 官方行为 | 插件行为 | 证据 | 风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16 | 2 | 顶层键序 | `chat_context` 在第 7 位（紧跟 `chat_task`）、`model_config` 第 16、`session_type` 在 `task_id` 之后 | `chat_context` 被排到第 22、`model_config` 第 23、`session_type` 提到 `agent_id` 之前。**已修**：顶层键序改成官方那一串，`chat_context` 回到第 7 位、`model_config` 第 16 位、`session_type` 回到 `task_id` 之后 | `JS:132123` vs `request.ts:175-225` + `键集:"sends exactly these top-level keys, in this order"` | 中 | 必须对齐 |
| 17 | 2 | 插件多发的顶层键 | 没有 `code_language`、`chat_prompt`、`image_urls` 这三个顶层键（`code_language` 与 `thinking_effort` 两个字面量在整个官方 bundle 里 0 命中） | 恒发 `code_language: ""`、`chat_prompt: ""`、`image_urls: null`（`request.ts:189-191`）。官方的对应概念在 `chat_context.chatPrompt` / `chat_context.imageUrls` 里。**已修**：三个键全部删掉 | `JS:132123`、`JS:132178`；`键集:"sends exactly these top-level keys, in this order"` | 中 | 必须对齐 |
| 18 | 2 | 顶层 `system` 取值 | 发真实 system prompt（`system: A11 ?? ""`），**同时**把它 unshift 成 `messages[0]` 的 system 消息 | 恒发 `system: ""`，只走 messages 一路（`request.ts:193-197`）。注释说"服务端忽略顶层 system"——这不假，但官方照样发；一个 `system` 为空而 `messages[0].role === "system"` 的请求是可区分特征。**已修**：顶层 `system` 现在发真实 prompt，`messages[0]` 的 system 消息保留 —— 两处都发才是官方形状 | `JS:132123`、`JS:132108`；`键集:"keeps the top-level shape when a system prompt is present"` | 中 | 必须对齐 |
| 19 | 2 | reasoning effort 的载体 | 写进 `parameters`：`reasoning_effort`（字符串）、`enable_thinking`（bool）、`reasoning_budget_tokens`（int）、`preserve_thinking`（`JS:121996-122003`、`JS:132112-132118`） | 完全不用这条通道：改去补 `model_config.thinking_config.{disabled,enabled}.…is_default`（`request.ts:142-173`）。词表本身是对的（官方 `none\。**已修**：effort 改走 `parameters`（`reasoning_effort` + `enable_thinking`），`thinking_config.is_default` 那套 hack 整段删除。`reasoning_budget_tokens` / `preserve_thinking` 不写，因为 omp 不暴露 thinking budget，官方默认路径也不写 |low\|medium\|high\|xhigh\|max`，`JS:85158-85166`，与 `proto:13-21` 的 `ReasoningEffort` 同名；插件 `request.ts:85-86` 用同一组、把 `minimal` 折成 `low`），错的是通道——服务端很可能整段忽略，effort 与 `--thinking off` 都静默失效 | `JS:121989-122005`、`JS:132110-132121`；`键集:"sends exactly these parameters keys"`（钉住插件 `parameters` 只有 `max_tokens`） | 中 | 必须对齐 |
| 20 | 2 | `model_config` 内容 | 现造一个固定 10 键对象：`{key, display_name, model:"", format, is_vl, is_reasoning, api_key:"", url:"", source, max_input_tokens}`。**不含 `thinking_config`** | 把目录缓存条目原样回传（服务端下发的任何字段都在里面），只覆写 `key`、再往 `thinking_config` 里塞 `is_default`（`request.ts:66-76`、`request.ts:142-173`、`request.ts:215`）。**已修**：改成现造官方那 10 键固定对象，目录条目的其它字段（含 `thinking_config`）不再回传。BYOK / custom_model 分支不移植（omp 无此路径） | `JS:132131` vs `键集:"sends the cached model config through as model_config, key first"` / `键集:"appends key to the end when the cached config does not have one"` | 中 | 必须对齐 |
| 21 | 2 | `chat_context.extra.modelConfig.thinking_effort` | 无此字段（`chat_context` 只有 `JS:132178` 的固定形状；`thinking_effort` 字面量在官方 bundle 里 0 命中） | 有 effort 时插入（`request.ts:208`）。**已修**：`chat_context.extra.modelConfig` 回到只有 `key` 与 `is_reasoning` 两键 | `JS:132178`；`键集:"sends exactly these chat_context.extra.modelConfig keys, in this order"` | 中 | 必须对齐（与第 19 行一并处理） |
| 22 | 2 | `chat_context` 键序 | `{text, features, extra, chatPrompt, imageUrls}` | `{chatPrompt, imageUrls, extra, features, text}`——五个键同名同值，顺序整个反过来（`request.ts:200-214`）。**已修**：键序改成 `{text, features, extra, chatPrompt, imageUrls}` | `JS:132178`；`键集:"sends exactly these chat_context keys, in this order"` | 低 | 必须对齐 |
| 23 | 2 | `chat_context.text` / `originalContent` 取值 | 最后一条 user 消息的 content，且**只在它是 string 时**取，否则空串（`JS:132170-132176`） | 数组 content 也会把 text 段拼起来（`request.ts:105-110`），带图片的轮次两侧结果不同 | `JS:132170-132176` vs `request.ts:101-113` | 低 | 无需对齐（值差异不改变服务端解析路径，且插件这版信息量更全） |
| 24 | 2 | assistant 消息的 reasoning 字段 | 独立字段承载：`reasoning_content`、`reasoning_content_signature`、`reasoning_item`，另有与 `content` 并存的 `contents` 分块数组（`JS:111995-112006`）；`proto:59-74` 的 `ChatMessage` 也声明了 `reasoning_content` / `reasoning_item` | 把 thinking 内联成字面量 `<thinking>…</thinking>\n\n` 拼进 `content`（`transform.ts:143-144`），不发 `contents`，也不回传 signature。**已修**：thinking 不再内联进 `content`，改由 `reasoning_content` / `reasoning_content_signature` / `reasoning_item` 三个独立字段承载，并补上 `contents` 分块数组。这一条是第 39 行的前置 | `JS:111965-112006`、`proto:59-74` vs `transform.ts:33-39`、`transform.ts:133-173` | 中 | 必须对齐（服务端已声明这些字段；把推理文本混进 content 还会教模型继续吐标签，而插件正为此维护 `ThinkingTagParser`——因果关系待面 3 确认，此处不作结论） |
| 25 | 2 | prompt cache 断点 | 在最后一条（`skipCacheWrite` 时是倒数第二条）消息的最后一个非 thinking/tool 块上打 `cache_control: {type:"ephemeral"}`（`JS:102851-102869`），user/assistant 的文本块也逐块透传 `cache_control`（`JS:111938-111940`、`JS:111972-111974`） | 从不发 `cache_control`（`transform.ts:29-39` 的 part 类型里没有这个字段）。**已修**：新增 `src/prompt-cache.ts` 的 `applyPromptCacheBreakpoint`，在转换前的 pi 消息数组上打断点，标记随转换流进 `contents`。pi 没有 `tool_result` 块类型（tool 输出是整条 `toolResult` 消息），所以该角色收尾的一轮不打断点 —— 这与官方一致：官方的 tool_result 是块，会被跳过集合滤掉，同样不打 | `JS:102851-102869`、`JS:111938-111940`、`JS:111972-111974`、`proto:91-93` | 中 | 必须对齐 |
| 26 | 2 | `tool_calls` 元素缺 `index` | `{id, type:"function", index, function:{name, arguments}}`（`JS:111990`） | `{id, type:"function", function:{…}}`，无 `index`（`transform.ts:23-27`、`transform.ts:147-155`）。**已修**：补上 `index`，键序 `{id, type, index, function}` | `JS:111990` vs `transform.ts:147-155` | 低 | 必须对齐 |
| 27 | 2 | `business` 的可选子字段 | `business` 本身是条件键（`JS:132123` 的 `...W !== void 0 ? {business:W} : {}`）；`proto:193-202` 另声明 `sub_task`，`JS:146170` 证明 gateway body 确实会带它；目录条目有 `function_switches` 且调用方给了选择时还会追加 `business.feature_switches`（`JS:132125-132128`、`JS:105108-105116`） | 恒发 7 键，无 `sub_task`、无 `feature_switches`（`request.ts:216-224`） | `JS:132123`、`JS:132125-132128`、`JS:146170`、`proto:193-202`；`键集:"sends exactly these business keys, in this order"` | 低 | 无需对齐（默认路径官方也不带这两个子字段） |
| 28 | 2 | 采样旋钮全缺 | `parameters` 可带 `temperature` / `top_p` / `top_k` / `tool_choice` / `context_length`，但**只在用户配置了 generation 偏好时**才写（`JS:121992-121995`、`JS:132120-132121`）；默认路径不写 | 永不写（`request.ts:199`，`parameters` 只有 `max_tokens`） | `JS:121989-122005`、`JS:132110-132121`；`键集:"sends exactly these parameters keys"` | 低 | 无需对齐（默认路径两侧一致；omp 也不暴露这些旋钮） |
| 29 | 2 | `max_tokens` 兜底常数 | proto 用 `google.protobuf.Int32Value`（wrapper，语义是"缺省可与 0 区分"），但官方 gateway 侧恒发裸整数并兜底：`cZ()` 在值非正整数时回落 **32000**（`JS:105458-105461`、`JS:132111`） | 同样恒发裸整数，兜底 **32768**（`request.ts:73`、`request.ts:129-135`）。**已修**：兜底改成官方的 32000，并照 `cZ` 语义接受数字字符串、拒绝非正整数 | `proto:31`、`JS:105458-105461`、`JS:132111` vs `request.ts:129-135`；`src/__tests__/request-body.test.ts` 的 `describe("buildChatRequest clamps a bad cached max_output_tokens")` 九条用例钉住插件的兜底 | 低 | 必须对齐 |
| 30 | 2 | `tools` 元素的 schema 声明字段 | `proto:118-132` 的 `Tool` 声明 `cache_id`、`function.strict`、`advisor`。官方 gateway body 的 `tools` 由调用方传入（`JS:132123` 的 `E?.tools ?? []`），本轮**没有**取到它的构造点，所以只能作 schema 级陈述 | 只发 `{type:"function", function:{name, description, parameters}}`（`transform.ts:61-70`） | `proto:118-132`；`键集:"sends exactly these tools element keys, in this order"` / `键集:"sends exactly these tools element function keys, in this order"` | 低 | 无需对齐（无证据表明官方实际发这三个字段） |
| 31 | 2 | `metadata.workspace` / `metadata.user` | `proto:174-190`、`proto:215-217` 声明 `WorkspaceMetadata`（`file_count`/`languages`/`codebase_status`/`codebase_soft_status`/`codebase_external_id`/`data_policy`）与 `UserMetadata{user_id}` | 无任何承载字段 | `proto:174-190`、`proto:215-217`；`键集:"sends exactly these top-level keys, in this order"` | 低 | 不能对齐（omp 没有 Qoder 的 codebase 索引，这些 workspace 指标无从产出；`data_policy` 已由 `Cosy-Data-Policy` 头覆盖，`user_id` 已由 `Cosy-User` 头覆盖） |

#### 面 2 未覆盖

- **官方 `tools` 与 `business` 的构造点**。两者在 `JS:132123` 都是调用方传入的参数，本轮没有回溯到源头，所以第 27、30 行只给了 schema 级或条件级结论。
- **`stream_options.include_usage`**。两侧都不发；插件确实收到了 usage（`events.ts:53-63` 记录了实测到的字段子集，`src/__tests__/stream.test.ts:"captures usage, responseId and responseModel from the finish chunk"` 钉住映射），所以缺这个字段目前没有可观测后果。是否有边缘情况属面 3。
- **`messages` 的完整变换链**。官方在 `DuA`（`JS:112273-112286`）之前还过 `KPH`，之后 assistant/user 各走 `kCQ`/`zCQ`；本轮只核对了 reasoning 字段、`contents`、`cache_control`、`tool_calls.index` 四处，没有逐块比对 tool_result 与图片的编码。

### 面 3：响应流解析

**先纠一处入口。**Task 8 简报让搜 `handleSSEMessage` / `case"connected"` / `stream_error`。`handleSSEMessage`（`JS:119598-119618`）是**配置中心 SDK** 的 SSE，事件只有 `connected` / `config:change` / `heartbeat`，与 chat 无关；`stream_error` 是错误分类词表里的一个 code（`JS:113491`），不是流事件。chat 的流解析在
`JS:133069-133254`（StreamAdapter 主循环）、`JS:132788-132816`（包络解析 `z3`）、`JS:132589-132723`（SSE 分帧生成器）、`JS:132826-132845`（`finish_reason` 归类）。以下行号都指这几处。

**官方 chat SSE 不解密。**`decrypt_server_response` 的四个调用点全是非流式 JSON：目录缓存（`JS:105922`）、`listModelsFromRemote`（`JS:117849`）、`/api/v3/user/status`（`JS:117916`）、`/api/v2/quota/usage`（`JS:117937`），封装在 `JS:1028-1038`。StreamAdapter 的取数路径（`JS:133133-133151`）没有解密调用。

| # | 面 | 项 | 官方行为 | 插件行为 | 证据 | 风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 32 | 3 | SSE 分帧粒度 | 按**事件块**分帧：空行才交付一帧，多条 `data:` 用 `\n` 拼接，`event:` / `id:` 随帧带出，`retry:` 显式忽略，只剥一个前导空格与行尾 `\r`，另有单行与单事件的字节上限（`JS:132668-132708`、`JS:132678`、`JS:132691`、`JS:132694-132702`） | 按**行**分帧：每条 `data:` 行独立交付，`event:` 与 `id:` 直接丢弃（`sse.ts:42`），payload 两端 `trim()`（`sse.ts:40`、`sse.ts:43`），无字节上限。**已修**：`sse.ts` 重写为有状态的事件块分帧器（`SSEFramer`），`event:`/`id:` 保留并随帧交给解析器，值不再 trim、只剥一个前导空格、只去行尾一个 `\r`，并补上官方的单行 16 MiB / 单事件 32 MiB 上限 | `JS:132668-132708` vs `sse.ts:34-46`；`src/__tests__/sse.test.ts:"drops lines that are not data fields"` 明确钉住"丢弃 `event:`" | 中 | 必须对齐 |
| 33 | 3 | 哨兵字符串全集 | 四种：`[DONE]`、`[NOT_EXCEED_QUOTA]`、`[EXCEED_QUOTA]…`、`[NOTIFICATIONS]#…`（`JS:132782-132786`），外层与包络内 `body` 两处都判；`[NOTIFICATIONS]#` 后面那段 JSON 会解出 `notifications` 交给 `onCreditNotification`（`JS:133060-133068`、`JS:133137-133146`、常量 `JS:133255`） | 只认 `[DONE]`（`events.ts:113`、`events.ts:122`）。另外三个既不是 `[DONE]` 也不是合法 JSON，走到 `JSON.parse` 抛 `SyntaxError`，被"单行坏了不杀流"的分支静默跳过（`events.ts:145-150`）。**本行原先写"配额耗尽与额度通知因此完全不可见"，这是夸大，已改正**：`EXCEED_QUOTA` 在整个 bundle 里只有 `JS:132786` 那一处定义点命中（字符串搜索，此处只用于确认"无其它引用"这一否定事实），官方自己也没有消费者 —— `wcA` 命中后 `z3` 返回 null 直接 `continue`。所以对齐这两个配额哨兵只是把"靠抛异常被静默跳过"换成"显式跳过"，**可观测行为不变**。真正的功能缺口只有 `[NOTIFICATIONS]#`：官方解出 `notifications` 交给 `onCreditNotification`，插件整个丢掉。**已修**：四个哨兵全部显式识别；`[NOTIFICATIONS]#` 裸串与包一层两种形式都解出 `notifications` 并用 `console.warn` 报给用户（pi 事件流没有账户状态通道，而终态通知意味着后续请求都会失败） | `JS:132782-132786`、`JS:133137-133146` vs `events.ts:112-129`、`events.ts:141-152` | 中 | 必须对齐 |
| 34 | 3 | 错误包络的判定与分类 | 进错误分支要求 `statusCodeValue` 与 `body` **都存在**，且 `event !== "finish"`（`JS:132791-132793`）；然后把 body 解成 `qoderApiError`，映出 401 / `duplicateRequest` / `modelQueued` / `retryAfterMs`，body 里含 `login expired` / `login timeout` 也强制成 401（`JS:132794-132805`）；顶层 `d.error` 另抛（`JS:133157`） | 只看 `envelope.statusCodeValue` 真值且 `!== 200`，抛一条纯文本 Error（`events.ts:117-119`），没有分类、没有 401 归一、没有重试提示；`inner.error` 不检查。**又因为面 3 第 32 行丢了 `event:`，官方豁免的 `event: finish` 非 200 帧在插件这里会变成硬错误**。**已修**：判定改为两字段都存在，错误分支要求 `statusCodeValue !== 200 && event !== "finish"`，抛出的错挂 `status`/`retryAfterMs`/`duplicateRequest`/`modelQueued` 并做 401 归一；无包络时顶层对象即 payload（原先 `if (!innerStr) return "continue"` 会把整块丢掉，是真 bug）。完整错误码词表未移植 | `JS:132788-132806`、`JS:133157` vs `events.ts:115-119`、`events.ts:131-139` | 中 | 必须对齐 |
| 35 | 3 | `finish_reason` 词表 | `GcA`（`JS:132826-132845`）：`stop`→`end_turn`、`tool_calls`/`function_call`→`tool_use`、`length`→`max_tokens`、`content_filter`/`refusal`→`refusal`、`"null"`/`null`/`undefined`→无终止，**其余抛 `UnsupportedFinishReasonError`**；另有前置表 `QsL`：`model_context_window_exceeded` 抛 status 413 的错（`JS:132821-132824`、`JS:132854`） | 七键映射表（`events.ts:40-51`）缺 `refusal`，也没有 `model_context_window_exceeded`；未命中一律当 `stop`（`events.ts:290-298`）。后果：上下文溢出的一轮会报成正常完成，只是输出被截断，用户看不到任何提示。`"null"` 这个字符串是真值，也会走到映射表并落到 `stop`。**已修**：`model_context_window_exceeded` 现在抛 status 413 的错而非静默当成完成；字面串 `"null"` 不再覆盖 stopReason；补齐 `refusal` 键。未知 reason 仍保持宽松（有意偏离，官方在此抛 `UnsupportedFinishReasonError`） | `JS:132821-132845`、`JS:132854` vs `events.ts:40-51`、`events.ts:286-299`、`events.ts:138` | 中 | 必须对齐 |
| 36 | 3 | reasoning 通道全集 | 三条：`reasoning_content`（thinking_delta）、`reasoning_item`（`summary[].text` 拼成 thinking；`encrypted_content` 单独开一个 `redacted_thinking` 块）、`signature`（补到 thinking 块上的 `signature_delta`），并处理 thinking 与 text 块的互斥切换与交错缓冲（`JS:133100-133122`、`JS:133174-133182`） | 只处理 `reasoning_content`（`events.ts:20-21`、`events.ts:157-179`）。`reasoning_item` 与 `signature` 都不接收，所以差异第 24 行里"不回传 signature"是**没有来源**，不是选择不发。**已修**：三条通道全接。`reasoning_item.summary` 拼接进同一 thinking 块，`encrypted_content` 另开一个 `redacted: true` 块并把密文放进 `thinkingSignature`，`signature` 累加到它认证的那个块上。官方的 thinking/text 交错缓冲不移植（块编号模型不同，已记入「面 3 未覆盖」） | `JS:133100-133122` vs `events.ts:19-28`、`events.ts:155-179` | 中 | 必须对齐 |
| 37 | 3 | 遗留 `function_call` 分片 | 收到 `delta.function_call` 且没有 `tool_calls` 时，就地合成一条 `tool_calls[0]`（首片带 `fc_<messageId>_<index>` 形式的 id，后续片只带 arguments），再走统一路径（`JS:133166-133171`） | `QoderDelta` 里没有这个字段（`events.ts:19-28`），整条分片被忽略。**已修**：`function_call && !tool_calls` 时就地合成 `tool_calls[0]`，首片带 id、后续片只带 arguments | `JS:133166-133171` vs `events.ts:19-28`、`events.ts:155-283` | 低 | 必须对齐 |
| 38 | 3 | 工具调用流的容错 | 参数 JSON 截断时做修复：抽出补全后缀并再发一段 `input_json_delta`（`JS:133237-133239`），插入内容前先关掉未完成的工具块（`JS:133088-133095`），孤儿分片（有 arguments 无对应 index）抛 `MalformedToolCallStreamError`（`JS:133072`、`JS:133206`）；声明了 `tool_calls` 却没有块时只打 warn 并**保留** `tool_use`（`JS:133220`） | 参数解析不了就静默当 `{}`（`events.ts:323-326`）——半截 JSON 直接变成空参数调用；孤儿分片被 `state.contentIndex` 默认 0 的保护挡住但不报错（`events.ts:265-281`）；声明了 `tool_calls` 却没有块时**抛硬错**（`events.ts:346-354`）。**已修（JSON 修复这半）**：截断参数先按未闭合的括号/引号补全再解析，修不好则抛错并带前若干字符 —— 这比原先静默当 `{}` 更严，也比官方的 `"{}"` 兜底更严，理由是空参数工具调用比失败更危险 | `JS:133072`、`JS:133088-133095`、`JS:133206`、`JS:133220`、`JS:133237-133239` vs `events.ts:265-281`、`events.ts:320-341`、`events.ts:343-354` | 中 | 必须对齐（**只指 JSON 修复这半**。抛硬错那半是插件有意选择，理由写在 `events.ts:343-354`，比官方的"保留 tool_use 但没有工具"更安全，保留） |
| 39 | 3 | `<thinking>` 字面标签 | 流里**不做任何标签解析**：`l.content` 直接变 `text_delta`（`JS:133184-133187`），thinking 只来自第 36 行那三条结构化通道。整个 bundle 里 `<thinking>` 字面量 0 命中（字符串搜索，仅作旁证，结论以 `JS:133184-133187` 的正读为准） | ~~对 `content` 跑 `ThinkingTagParser`，还要在 `reasoning_content` 上剥标签~~ **已修**：解析器与 `thinking-parser.ts` 整个删除，`content` 原样成为 text delta。**前置条件已满足**（第 24 行先落地，thinking 不再内联），且**取证到了台账原先拿不到的样本**：真实网关约 2 万字符推理响应里字面 `<thinking>` 零命中（`scripts/live-alignment-check.ts:"the real gateway never emits a literal <thinking> tag"`）。不保留作为兜底，因为它同样会改写正当提到该标签的文本 | `JS:133184-133187`、`JS:133100-133122` vs `events.ts:155-212` | 低 | 必须对齐（**次序依赖差异第 24 行**：标签是插件自己把 thinking 内联进回传 `content`（`transform.ts:143-144`）教出来的，先修第 24 行再拆解析器；顺序颠倒会当场回归，`stream.test.ts:"keeps tool call arguments intact when a <thinking> tag leaks into content"` 就是为此存在的） |
| 40 | 3 | 响应解密 | 非流式 JSON 一律过 `decrypt_server_response`：目录缓存（`JS:105922`）、`listModelsFromRemote`（`JS:117849`）、`/api/v3/user/status`（`JS:117916`）、`/api/v2/quota/usage`（`JS:117937`）；封装 `JS:1028-1034` 在 WASM 抛异常时原样返回入参，`JS:1035-1038` 再 `JSON.parse`。SSE 流不解密 | ~~一处都不解密~~ **已修**（第二阶段第一批）：新增 `qoder-encoding.ts` 的 `qoderDecodeBody` / `parseQoderJsonBody`（旋转步骤是对合，逆运算＝反替换＋同互换），目录与配额两处都改走它 | **本轮实测**（加载官方 WASM 直接调 `decryptServerResponse`）：① 它是请求体混淆的**精确逆运算**——把 `{"hello":"world","n":42}`、`{"assistant":[{"key":"auto"}]}`、`{}` 用 `qoder-encoding.ts` 编码后喂进去，逐字返回原串；② 对明文是**恒等**——`{"a":1}`、`{"json":true}`、`""`、`{"assistant":[]}`、`not json at all` 全部原样返回。官方之所以敢无条件调用，正是因为它对明文是直通。`JS:105922`、`JS:117849`、`JS:117916`、`JS:117937`、`JS:1028-1038` vs `models.ts:166`、`usage.ts:50` | 中 | 必须对齐。插件今天能跑，说明服务端对它的请求**当前**返回明文——这是对当下服务端行为的观察，不是保证。注意插件的 chat URL 是带 `Encode=1` 的（`cosy.ts:104`），可见这个 flag today 并不单独决定响应是否编码；`Encode=1` 究竟控制什么本轮没测，不要据此推论。因为该函数对明文恒等，**加上它严格优于不加**：今天零行为变化，服务端哪天改成编码返回，区别就是优雅处理与满屏乱码 |

#### 面 3 未覆盖

- **`cache_write_tokens` 的语义**。官方 `LS`（`JS:132900-132908`）只读 `prompt_tokens_details.cached_tokens`，不读 `cache_write_tokens`；插件读（`events.ts:80`），注释说是实测到的字段。本轮没有抓到能证实或否证其语义的响应样本，故不列为差异行。
- **官方块流的下游语义**。StreamAdapter 输出的是 Anthropic 形状的 `content_block_*` 事件，块序号带 `B += U` 的偏移与负索引哨兵（`Mz = -1`、`To = -2`，`JS:133255`）。插件输出 pi 的事件形状，两者的块编号规则无法逐一对应，只比对了"什么触发开块/关块"，没比对编号。
- **超时与空闲看门狗的数值**。官方 SSE 侧有首包与空闲两档超时、单行/单事件字节上限（`JS:132639-132640`、`JS:132694`、`JS:132735-132739`、`JS:132776`）；插件有自己的看门狗（`transport.ts`、`stream.ts:98`）。数值没逐项核对，与面 1 未覆盖的"重试与超时策略"是同一笔账。
- **`event: finish` 是否真的会带非 200 `statusCodeValue`**。第 34 行的后果推断建立在官方为它专门开了豁免（`JS:132793`）这一事实上，但本轮没有抓到这样的实际帧。

### 面 4：模型目录与配额

| # | 面 | 项 | 官方行为 | 插件行为 | 证据 | 风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 41 | 4 | scene 解析与跨场景合并 | 遍历响应里**每一个** scene（配置 scene 排第一），配置 scene 的条目在 `allModels` 里覆盖同 key 的其他 scene，`is_default` 只认配置 scene，配置 scene 缺失时打 warn 但不失败（`JS:105953-105970`）；配置 scene 还会并入 `byok_enterprise` 那一档（`JS:105500-105514`，常量 `JS:106048`），按去重键跳过已有条目。配置 scene = `getClientMetadata().scene`，默认 `"assistant"`（`JS:106064`、`JS:400-402`、`JS:404`） | `resData.assistant \|\| resData.chat`（`models.ts:173`）：只取一个 scene，不合并、不并 `byok_enterprise`、不记 `server_scene`；而且 `assistant` 缺失时**静默退到另一个 scene**（`chat` 是旧端点的缩减目录），拿到的是一份不同的目录却毫无提示 | `JS:105953-105970`、`JS:105500-105514`、`JS:106064` vs `models.ts:166-181`；`src/__tests__/models-cache.test.ts:"prefers the assistant scene over chat (qodercli default scene)"` 钉住优先级 | 中 | 必须对齐 |
| 42 | 4 | 目录字段不参与本地决策 | 解析并保留 `efforts` / `supports_disabled` / `default_effort` / `available_context_windows` / `default_context_window` / `context_config` / `thinking_config` / `feature_switches`（兼容 `function_switches`）/ `strategies` / `promotion` / `price_factor` / `original_price_factor` / `is_free` / `tags` / `server_scene`（`JS:105961`、`JS:117859-117860`），并据此做灰度与计费展示 | 只从条目里推出五项：`reasoning`（`is_reasoning \|\| thinking_config`）、`supportsEffort`（`thinking_config.enabled.efforts`）、`input`（`is_vl`）、`contextWindow`、`maxTokens`（`models.ts:195-215`）。其余字段一个都不解析 | `JS:105961`、`JS:117859-117860` vs `models.ts:195-215` | 低 | 无需对齐（原始条目整体留在 `configs` 里并原样回传成 `model_config`，见差异第 20 行，所以服务端仍然看得到这些字段；插件只是不据此做本地决策） |
| 43 | 4 | 服务端的默认模型 | 从配置 scene 里 `is_default` 为真的条目取 `defaultModelKey`（`JS:105964`、`JS:105971`） | 完全不读 `is_default`（`models.ts:179-215`），模型顺序就是响应顺序 | `JS:105964`、`JS:105971` vs `models.ts:179-215` | 低 | 无需对齐（omp 自己管默认模型的选择，服务端观测不到这个差异） |
| 44 | 4 | 上下文窗口的选择 | 记下服务端给的 `available_context_windows` 与 `default_context_window`，`context_config` 的 windows 优先（`JS:105961`），**不改写**条目里的 `is_default` | ~~取最大档当 `contextWindow`，并把 `is_default` 重写到最大那档上回传~~ **已修**：本地「选最大档当 `contextWindow`」是产品选择，**保留**（`models.ts:104-122` 未动）；但那条「被改写的对象被回传给服务端」的后果**已被第 20 行顺带消除** —— `buildModelConfig` 现在只回传固定 10 键，`context_config` / `is_default` 根本不进 wire，服务端不再收到插件编的 `is_default` | `JS:105961` vs `models.ts:104-122`、`models.ts:184-194`、`request.ts:215` | 中 | 必须对齐（要不要默认用最大窗口是产品选择，可以保留；**但不能把改写后的 `is_default` 回传给服务端**） |
| 45 | 4 | 配额与额度 | 三个来源：`/api/v2/user/plan`（`JS:117873`）、`/api/v3/user/status`（`JS:117905`）、`/api/v2/quota/usage`（`JS:117930`）；流内还从 usage 里取 `credits` / `original_credits` / `billable`（`JS:132904-132907`），配合 `[EXCEED_QUOTA]` / `[NOT_EXCEED_QUOTA]` 哨兵（`JS:132786`） | 只读 `/api/v2/quota/usage`（`cosy.ts:115-117`、`usage.ts:37-44`，端点与官方**同一个**）；`mapUsage` 不取 `credits` / `original_credits` / `billable`（`events.ts:54-63`、`events.ts:75-88`）；哨兵见差异第 33 行 | `JS:117873`、`JS:117905`、`JS:117930`、`JS:132904-132907` vs `usage.ts:36-85`、`events.ts:54-88` | 低 | 无需对齐（都只影响本地展示；`/api/v2/quota/usage` 已足够，另两个端点不必加） |
| 46 | 4 | 目录缓存与刷新节奏 | 按 uid 分文件的共享缓存，用响应正文的 md5 去重（相同就只 touch mtime）（`JS:105922-105940`）；后台 120 s 一次同步、启动时 0–30 s 随机抖动、共享缓存 100 s 内视为新鲜（`JS:106007-106019`、常量 `JS:106048`）；两次 fetch 间隔小于 10 s 直接跳过（`JS:105899-105902`） | 单个 JSON 文件，1 小时过期（`models.ts:124-135`），只在登录与 token 刷新时刷（`oauth.ts:159`、`oauth.ts:172`、`oauth.ts:203`、`oauth.ts:272`），没有后台同步、没有 md5 去重、没有抖动 | `JS:105899-105940`、`JS:106007-106019` vs `models.ts:124-135`、`oauth.ts:159-272` | 低 | 无需对齐（插件刷得比官方**少**，不构成请求频率上的异常特征；缓存新鲜度是本地取舍） |

#### 面 4 未覆盖

- ~~**目录响应的实际 scene 集合**无从确认~~ —— **已实测**（`npx tsx scripts/live-alignment-check.ts`，真实 `model/list` 200 响应 65458 字节）：响应里有 **10 个 scene**，依次为 `chat`、`assistant`、`inline`、`quest`、`nap`、`qwork`、`experts`、`qwake`、`byok_teams`、`byok_enterprise`。**`byok_enterprise` 确实出现**，所以第 41 行讲的"官方还会并入 `byok_enterprise` 那一档"不是纸面推断。`assistant` 一档 16 条 —— 插件只取这一档，官方跨 scene 合并后条目更多，这正是第 41 行的工作量。另：服务端对该请求返回的是**明文**，所以第 40 行的解码在今天是直通。
- **`strategies` 的灰度语义**。官方把它解析成 `{tag, enabled, disabled_message_key}`（`JS:105516-105524`）并 debug 打印每个条目的 `strategies`（`JS:105960`），但用它做什么判断本轮没有回溯到。
- **`price_factor` 与 `ZERO_COST`**。插件把所有模型的 cost 写成 `ZERO_COST`（`models.ts:212`）。官方拿 `price_factor` 做计费展示。是否有服务端可观测的后果不明，故不列为差异行。

### 面 5：认证与身份

这一面同时是差异第 14 行的判定依据。`generate_runtime_auth_fields` 已经**固化进预言机**：`carve-glue.mjs` 从底层 wasm-bindgen 导出表（`JS:415`，snake_case 的那张，与高层包装表是两张不同的表）把它一并带出，`scripts/cosy-oracle.mjs` 的 `runtimeAuthFields()` 封装调用形状，两条用例分别钉住"两字段都算得出来"与"同输入两次密文不同"。所以第 14、50 行的结论现在可以直接重跑，不再依赖一次性的手工测量。

**`scripts/cosy-oracle.mjs` 的注释曾断言这两个值来自登录响应，已随本轮修正**（`428e4f0`）：`uid` 确实来自登录响应，另两个是本地算的。

| # | 面 | 项 | 官方行为 | 插件行为 | 证据 | 风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 47 | 5 | openapi 辅助请求的请求头 | `openApiJsonRequest` 只发 `Accept: application/json` 与 `User-Agent: qoder/<version>`，有 token 才加 `Authorization`，有 body 才加 `Content-Type`（`JS:114954-114957`）。**一个 COSY 头都不发** | ~~PAT 交换额外发 `Cosy-Version: 1.0.1` 与 `Cosy-ClientType: 5`~~ **已修**：两个头已删（`pat.ts` 的 PAT 交换现在只发 `Content-Type` / `Accept` / `User-Agent`）。userinfo 请求本就不发多余头，台账原先标的 `pat.ts:109-115` 行号已过期。顺带清掉了 `1.0.1` 这个版本串。**已在线验证**：删掉后 PAT 重新交换仍返回 200（`scripts/live-alignment-check.ts` 的 "token refresh (PAT re-exchange)" 通过） | `JS:114954-114957` vs `pat.ts:60-66`、`pat.ts:109-115` | 中 | 必须对齐 → **已对齐** |
| 48 | 5 | 辅助请求的 `User-Agent` | 每个 openapi 与刷新请求都发 `qoder/<version>`（`JS:114954`、`JS:115104`、`JS:115138`） | 全部发 `omp-provider-qoder`（`cosy.ts:27`，用在 `pat.ts:63`、`pat.ts:112`、`oauth.ts:234`、`login.ts:140`、`login.ts:179`、`usage.ts:42`） | `JS:114954`、`JS:115104`、`JS:115138` vs `cosy.ts:21-27` | 低 | 无需对齐（**有意**：`cosy.ts:21-27` 明确写了这是自报身份、不冒充官方客户端，签名头才承载真实客户端标识。这是 fork 的取舍，不是 bug） |
| 49 | 5 | userinfo 响应的读取 | 取 `id`/`user_id`/`uid` 三个别名之一当 uid，缺则**硬失败**；`name`/`username`/`user_name`、`email`、`avatar_url`、`organization_id`（另回退到 `organization.id`）、`organization_name`、`organization_tags`（含 `organizationTags` 驼峰）、`is_data_policy_modifiable` 全都读，并校验 uid 与已存凭据一致（不一致抛 403）（`JS:114995-115002`）；组织 tags 还会再拉一次补全（`JS:114942-114948`） | **后果 ① 已修**：`pat.ts:117-134` 现在按官方的三个别名读 uid（`id`/`user_id`/`uid`）与三个别名读 name，`src/__tests__/pat.test.ts` 的 `"reads the uid from %s"` / `"reads the display name from %s"` 逐别名钉住，所以服务端换字段名不会再让 `userID` 变空串。**后果 ② 也已修**：`pat.ts` 现在按官方的别名读 `organization_id`（含 `orgId` / `organizationId` / 嵌套 `organization.id`）与 `organization_tags`（含驼峰，并过滤成字符串数组），穿过凭据交给签名层。原文：失败时静默吞掉（`pat.ts:135-137`）；② `organization_id` / `organization_tags` 拿不到——而它们正是官方喂给 `generate_runtime_auth_fields` 的输入（`JS:114929`，见差异第 14 行）与组织头的来源（见差异第 8 行） | `JS:114942-114948`、`JS:114995-115002` vs `pat.ts:103-131` | 中 | 必须对齐 |
| 50 | 5 | `info` / `Cosy-Key` 的生命周期 | **每凭据一次**：`regenerateRuntimeFields()` 只在登录（`JS:114630`、`JS:114651`）与 token 刷新（`JS:115126`、`JS:115145`）时调，算出的一对灌进 QoderContext（`JS:114891-114892`、`JS:115147`），此后每个请求原样回放 | ~~**每请求一次**：现摇随机 AES key、每个请求的 `Cosy-Key` 都不一样~~ **已修**：改成按凭据缓存（`cosy.ts:294-334` 的 `runtimeAuthFields`），缓存键含 authToken，所以登录或刷新换 token 时自然重算，等价于官方的时机。`src/__tests__/cosy-signature.test.ts` 的 `"replays the same Cosy-Key across requests made with one credential"` / `"recomputes the pair when the token changes, which is what login and refresh do"` / `"still varies the per-request fields"` 钉住三面 | `JS:114891-114892`、`JS:114927-114931`、`JS:115145-115147` vs `cosy.ts:287-356`；`预言机:"replays the credential-supplied user info and key verbatim"`；`预言机:"produces a different pair on every call for the same input"`：`generate_runtime_auth_fields` 同输入连调两次密文不同，所以"每请求重算"在服务端是能看出来的 | 中 | 必须对齐 |
| 51 | 5 | machine id 的推导与落盘 | 优先由硬件推导：`sha256("<salt>:linux:<硬件 uuid 小写>")` 再格式化成 UUID 形状，取不到或超时才随机（`JS:76181-76209`）；落盘走原子发布——`open(tmp,"wx",0o600)` + `link`，`link` 撞 `EEXIST` 就采纳已有值，失败再退 `rename`（`JS:76249-76282`），路径 `~/.qoder/.auth/machine_id`（`JS:76506`）；读取带重试与登录期修复（`JS:76222-76224`、`JS:76480-76495`） | ~~从不由硬件推导，也从不写官方路径~~ **已修（推导部分）**：新增 `deriveMachineIdFromHardware()`，逐行复刻官方公式（sha256 over `<salt>:linux:<uuid>`、取前 16 字节、置 v4 变体/版本位、8-4-4-4-12 格式化，`cosy.ts` 的 `deriveMachineIdFromHardware`），两个文件都读不到时优先用它而非随机值。**但本机 `/sys/class/dmi/id/product_uuid` 是 root-only，官方是 root 进程读得到，Node 插件读不到 → 本机仍回退随机**；硬件推导只在 DMI 可读的部署上生效。官方的原子落盘（`open(wx)`+`link`）未移植：omp 无并发多客户端共享同一路径的场景 | `JS:76181-76209`、`JS:76249-76282`、`JS:76506` vs `cosy.ts:265-285` | 中 | 必须对齐 → **已对齐（推导部分；落盘策略保留插件现状）** |
| 52 | 5 | device token 的刷新端点 | `POST <openapi>/api/v1/deviceToken/refresh`，体 `{refresh_token}`，头 `Content-Type` + `Accept` + `User-Agent: qoder/<version>`（`JS:115104`） | `POST <center>/algo/api/v3/user/refresh_token`，体 `{refreshToken}`（驼峰）（`cosy.ts:119-121`、`oauth.ts:226-237`）。这条路径在官方 1.1.23 的 bundle 里**命中 0 次**；失败后静默把有效期延一小时（`oauth.ts:278-283`），所以刷新一直不成功也不会有人发现 | `JS:115104` vs `cosy.ts:119-121`、`oauth.ts:226-283`；`cosy.test.ts:getQoderRefreshURL:"constructs correct global URL"` / `"constructs correct CN URL"` 钉住插件当前这条 URL（**它们钉的是现状，不是正确值**） | 中 | 必须对齐 |
| 53 | 5 | device flow 的授权 URL 与轮询 | 授权 URL 带 `client_id`（CLI 用的那个固定 UUID，`JS:114161`、常量 `JS:114225`），参数序 `challenge, challenge_method, nonce, machine_id, client_id`；轮询只发 `Accept`，**只把 404 当 pending**（`JS:114166-114167`），间隔 1000 ms、总期限 300 s（`JS:114225`） | 授权 URL **没有 `client_id`**，参数序 `challenge, challenge_method, machine_id, nonce`（`login.ts:118`）；轮询多发 `User-Agent`（`login.ts:140`），把 202 **和** 404 都当 pending（`login.ts:145`），间隔 2000 ms × 90 次 = 180 s（`login.ts:128-129`） | `JS:114159-114167`、`JS:114225` vs `login.ts:113-145` | 中 | 必须对齐（缺 `client_id` 是实质项，其余是参数细节） |

#### 面 5 未覆盖

- **`cosy.ts:21-27` 那句"Qoder does not validate it"**。第 48 行的判定建立在这句话上，但它本身没有实测支撑——需要用一个异常 UA 打一次 openapi 才能定论。
- **device flow 的 `client_id` 是否必需**。官方带，插件不带而登录仍然可用（这是插件在跑的功能），所以服务端当前不强制。是否会变、带不带是否影响风控，测不出来。
- **service account 与 BYOK 路径**。官方另有 `/api/v1/serviceToken/exchange`（`JS:114984`）、`isServiceAccount()` 分支（影响差异第 4 行的 `injectClientIdentityHeaders`）与 BYOK 目录（`JS:117946-117953`）。omp 侧没有对应概念，本轮没有比对。
- **`refresh_token_expire_time` 的处理**。官方在刷新前检查 refresh token 自身是否过期并主动作废凭据（`JS:115134-115136`）；插件把 `jobRefreshToken` 编进 refresh 串（`pat.ts:31`）却从不使用它（全仓只有编解码与测试引用），也不检查其过期。因为官方的 PAT 策略同样是重新交换 PAT（`JS:114654`、`JS:115115-115120`，与 `oauth.ts:196-208` 一致），这条死数据没有服务端可观测后果，故不列为差异行。

### 面 6：CN 版差异

**先回答那个问题：CN 与全球版的差异，在插件侧不只是域名——还有模型 key 映射（第 55 行），而且它是插件自己发明的一层，不是官方协议差异。签名与请求头在插件侧完全没有 CN 分支。**

全仓 `isQoderCNMode` 的分支只落在六处：域名（`cosy.ts:84`、`cosy.ts:88`、`cosy.ts:92`、`cosy.ts:181-187`）、本地文件名（`models.ts:30`、`identity-store.ts:29`）、provider id 与展示名（`models.ts:198-207`、`index.ts:28-53`）、登录文案（`login.ts:49`、`login.ts:60`、`login.ts:80`）、CN 静态目录与 reasoning 集（`models.ts:48`、`models.ts:62-88`）、模型 key 映射（`request.ts:65`）。`buildAuthHeaders`（`cosy.ts:287-356`）与 `computeCosySignature`（`cosy.ts:244-263`）都不接受 mode 参数，**签名与头只有一条路径**。

官方侧只能答一半：1.1.23 是全球版构建，region 只有 `us` / `sg` / `jp`（`JS:69612`），`gateway.qoder.com.cn` 在整个 bundle 里命中 0 次，`openapi.qoder.com.cn` 只出现在内置 Config SDK 的端点表里（`JS:119730`）。CN 版是另一个构建，本轮没有取证物。

| # | 面 | 项 | 官方行为 | 插件行为 | 证据 | 风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 54 | 6 | region 的选择 | region 表 `us: api1.qoder.sh` / `sg: api2.qoder.sh` / `jp: api3.qoder.sh`（`JS:69612`、常量 `JS:404`），**默认推理端点是 `api2`**（同行的 `eGA`）；实际用哪个由端点发现（`/api/v3/service/region/endpoints` 匿名签名版、`/api/v4/…` 带凭据版，`JS:77014-77034`）返回的 `center` / `inference` / `openapi` 三张表（`JS:77042-77045`）加 `/algo/api/v1/ping` 的健康探测决定：每个候选连打 10 次、必须 10 次全成、取截尾均值延迟（`JS:77099-77121`） | 所有用户硬编码 `api3.qoder.sh`（`cosy.ts:84`），也就是**日本 region**，与官方默认的 `api2`（新加坡）不同，更不做延迟探测 | `JS:404`、`JS:69612`、`JS:77014-77045`、`JS:77099-77121` vs `cosy.ts:83-85`。注意 `V.inferRequest.url` 里的 host 是本审计取证时**喂进去的输入**，不是官方默认值 | 中 | 必须对齐（与差异第 15 行同一处修复：接上端点发现，region 就不用猜） |
| 55 | 6 | CN 模型 key 映射的有损往返 | 不做任何 key 改写，直接用服务端下发的 `key`（`JS:105961` 的 `G.key ?? G.model_key`、`JS:117860` 的 `key: F`） | 正向表把好看的 id 映成 CN 服务端 key（`cosy.ts:123-142`，用在 `request.ts:65`），反向表再映回来（`cosy.ts:144-156`，用在 `models.ts:198`）。**正向表不是单射**：`qwen3.7-plus` 与 `qwen3.6-plus` 都 → `qmodel`；`glm-5.2` 与 `glm-5.1` 都 → `gm51model`；`minimax-m2.7` 与 `minimax-m3` 都 → `mmodel`。反向表每组只给一个（`qmodel`→`qwen3.7-plus`、`gm51model`→`glm-5.2`、`mmodel`→`minimax-m2.7`），**于是选 `qwen3.6-plus` / `glm-5.1` / `minimax-m3` 实际打到的是另一个模型，界面上毫无提示**。反向表还把 `q36fmodel` 与 `qfmodel` 都映到 `qwen3.6-flash`（`cosy.ts:149-150`），目录里同时出现两者时 `models.ts:200-201` 的 `configs[modelInfo.id]` 会互相覆盖、`models.ts:203` 还会 push 两个同 id 的模型 | `JS:105961`、`JS:117860` vs `cosy.ts:123-156`、`models.ts:198-215`、`request.ts:65`；`cosy.test.ts:getQoderCNDirectModel:"maps known model IDs to internal keys"` 把三组碰撞逐条钉住了；`cosy.test.ts:getQoderCNFriendlyModelInfo:"returns known friendly info for mapped keys"` 是反向表 | 中 | 必须对齐（静默换模型是实质问题。正确做法是不改写 key、用服务端下发的 `key` 当模型 id，只在展示名上做本地美化） |
| 56 | 6 | CN 静态目录兜底 | 没有静态目录：目录解析不出可用条目就返回 false / 空数组（`JS:105969`、`JS:117854`），客户端此时就是没有模型 | 内置 CN 静态模型表与一份 17 项的 reasoning key 集合（friendly id 与服务端 key 混在一起），`max_output_tokens` 兜底 32768（`models.ts:48`、`models.ts:62-88`、`models-static.ts` 的 `staticCnModels`） | `JS:105969`、`JS:117854` vs `models.ts:48-88`、`index.ts:26-37` | 低 | 不能对齐（`registerProvider` 要求**同步**给出模型表（`index.ts:26-37`、`index.ts:62`），目录刷新是异步的，所以 omp 侧必须有一份离线兜底；官方 CLI 可以"暂时没有模型"，omp 不行） |

#### 面 6 未覆盖

- **CN 版在签名、请求头、模型 key 上是否真有差异**。本轮只有全球版 1.1.23 的取证物，CN 版（`qoderclicn`）的 bundle 没有提取，所以这个问题**无法回答**——上面第 55 行讲的是插件侧的映射层，不是官方 CN 协议。能定论的观察只有一个：对一份 CN 安装跑 `npm run audit:extract`，再用同一套预言机比对 `authRequest` / `inferRequest` 的 URL、头集与签名载荷。在拿到那份取证物之前，任何"CN 只是换域名"的说法都是推断。
- **`gateway.qoder.com.cn` 这个域名的来源**。它在官方全球版 bundle 里 0 命中，插件是从哪里得到它的本轮没有回溯到（可能来自 CN 版、也可能来自旧版本或抓包）。
- **CN 的 center 与 gateway 是否真是同一个域名**。插件让 `getQoderBaseUrl` 与 `getQoderCenterUrl` 在 CN 下都指向 `gateway.qoder.com.cn`（`cosy.ts:84`、`cosy.ts:92`），全球版则是两个不同域名（`api3.qoder.sh` 与 `center.qoder.sh`）。官方的端点发现把 center 与 inference 当两张独立的表（`JS:77042-77045`），所以 CN 下二者合一这件事需要 CN 侧取证才能确认。
- **VPC 部署**。官方支持 `<name>.vpc.qoder.com.cn` 形式的私有部署端点（`JS:68043`、`JS:293194`）。omp 侧没有对应概念，本轮没有比对。

## 已验证一致

这一节和差异表同等重要：**它划定第二阶段不要再去动的范围。** 每行都指到一个当前为绿的用例，
读者可以直接重跑。没有用例覆盖的事实一律写在「未覆盖」里，不放进这一节。

### 面 1：传输层指纹

| 项 | 结论 | 验证用例 |
| --- | --- | --- |
| 签名公式 | `md5(payloadB64 \n cosyKey \n timestamp \n body \n sigPath)`，与官方 md5 逐位相同（`cosy.ts:244-263`） | `锁定:"reproduces the official md5 signature"`（对 `V.signature.md5`）；`预言机:"signs with md5 over payload, key, date, body and the /algo-stripped path"`；`src/__tests__/cosy-signature.test.ts:"md5s payload, key, timestamp, body and sigPath joined by newlines"` / `"treats a null body as the empty string"` / `"hashes a Buffer body by its bytes, not by its string form"` |
| `sigPath` 推导 | 去 `/algo` 前缀、丢 query，与官方签名时用的路径一致（`cosy.ts:228-235`） | `锁定:"derives the same sigPath the official client signed"`；`src/__tests__/cosy-signature.test.ts:"strips the /algo prefix the gateway adds"` / `"drops the query string"` / `"leaves a path that has no /algo prefix alone"` |
| `Authorization` 载荷结构 | `Bearer COSY.<payloadB64>.<md5>`（`cosy.ts:336`），载荷五键 `{version:"v1", requestId, info, cosyVersion, ideVersion:""}`，`version` 为 `v1`、`ideVersion` 为空串（`cosy.ts:314-320`）。**只有键与这两个常量一致**，`cosyVersion` 的值见差异第 2 行 | `锁定:"builds the same Authorization payload shape"`；`预言机:"replays the credential-supplied user info and key verbatim"` |
| infer（chat）URL | `https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`，全串一致（`cosy.ts:103-105`） | `锁定:"matches the official infer URL"`（对 `V.inferRequest.url`）；`预言机:"emits the business identity headers on the infer request"` |
| `Cosy-Data-Policy` | 头名、大小写与值都一致。**机制也已查明**：它不是独立常量，而是 user-info 里 `data_policy_agreed` 的投影 —— 预言机实测 false → `disagree`、true → `agree`。插件原先硬编码 `disagree`，现改为按 `creds.dataPolicyAgreed` 投影，默认 false 时与官方等价 | `预言机:"projects data_policy_agreed onto Cosy-Data-Policy"`；`src/__tests__/cosy-signature.test.ts:"projects dataPolicyAgreed onto Cosy-Data-Policy"` |
| 请求体混淆编码 | `qoder-encoding.ts` 与 WASM 输出**逐字节相同**，覆盖 64 B JSON、1008 B、`{}`、含中文与 emoji 四组输入 | `锁定:"matches the wasm output byte for byte (case %i)"`（`it.each` 模板，`src/__tests__/cosy-oracle-vectors.test.ts:58`；渲染成 case 0…3 四条。**grep 要用 `%i` 这个字面量**，Task 7 原先写的 `(case 0..3)` 在仓库里搜不到）；`预言机:"obfuscates the infer body inside the wasm"`（另钉住 `4*ceil(n/3)` 的长度关系） |
| infer 传输头 | `Content-Type: application/json`、`Accept: text/event-stream`、`Cache-Control: no-cache`、`X-Model-Key`、`X-Model-Source` 五个头名与大小写一致（`transport.ts:201-209`）。**必须按最终 `fetch` 的合并结果比对**：这五个里有三个只在 `transport.ts` 出现，只读 `cosy.ts` 会误判成缺失 | 同上三条锁定用例（五者均未落入 missing/extra/casing 任一数组）；`预言机:"emits the business identity headers on the infer request"` 断言 `X-Model-Key`/`X-Model-Source` 的值 |
| 大小写正确的 COSY 头名 | `Authorization`、`Cosy-Key`、`Cosy-User`、`Cosy-Date`、`Cosy-Version`、`Cosy-Data-Policy`、`Login-Version` 七个头名与官方逐字符一致（`cosy.ts:336-353`） | 同上三条锁定用例 |

### 面 2：请求体构造

| 项 | 结论 | 验证用例 |
| --- | --- | --- |
| WASM 不参与 body 构造 | `prepareInferRequest` 对任意 JSON 串都只做整体混淆编码，不校验、不重排、不补字段——预言机喂只含一个键的 `{"session_id":"s-1"}` 也拿到合法输出。**推论：面 2 全部在 JS 层**，改 body 字段不会牵动签名层的实现（签名仍覆盖编码后字节，需重算） | `预言机:"obfuscates the infer body inside the wasm"`；`预言机:"emits the business identity headers on the infer request"`（body 只有一个键仍产出完整头集与 URL） |
| 顶层常量八项 | `stream: true`、`chat_task: "FREE_INPUT"`、`is_reply: true`、`is_retry: false`、`source: 1`、`version: "3"`、`agent_id: "agent_common"`、`aliyun_user_type: ""` 与官方逐字相同（`JS:132123` vs `request.ts:180-192`）。键名与位置由用例钉住，值是字面对照 | `键集:"sends exactly these top-level keys, in this order"` |
| `session_type` | 官方默认 `"qodercli"`（`JS:132123` 取 `JS:404` 的 `lIH`；`QODER_SESSION_TYPE` 可覆盖，`JS:406`；只有 qoder_work 模式才是 `"qoder_work"`），插件恒发 `"qodercli"`（`request.ts:186`） | `键集:"sends exactly these top-level keys, in this order"` |
| `task_id` | 默认路径两侧都是 `"common"`（官方 `JS:132123` 的兜底链末端；插件 `request.ts:188` 恒定） | `键集:"sends exactly these top-level keys, in this order"` |
| 三个 id 的字段名 | `request_id` / `request_set_id` / `session_id` 与官方 gateway body 同名同位置（`JS:132123`），且官方自己的日志属性也按这三个名字读（`JS:146170`） | `键集:"sends exactly these top-level keys, in this order"` |
| `chat_context.extra` | 三键与键序 `{context, modelConfig, originalContent}` 完全一致（`JS:132178` vs `request.ts:203-211`），`context` 两侧都是空数组 | `键集:"sends exactly these chat_context.extra keys, in this order"` |
| `chat_context.extra.modelConfig` 基础两键 | `{key, is_reasoning}` 的键与键序一致（`JS:132178`）。插件多插的 `thinking_effort` 见差异第 21 行 | `键集:"sends exactly these chat_context.extra.modelConfig keys, in this order"` |
| `chat_context` 的三个常量 | `features: []`、`chatPrompt: ""`、`imageUrls: null` 取值一致（`JS:132178` vs `request.ts:201-213`）。顺序见差异第 22 行 | `键集:"sends exactly these chat_context keys, in this order"` |
| `business` 字段名 | 七键 `{product, version, type, stage, id, name, begin_at}` 与 `proto:193-202` 的 `BusinessMetadata` 逐名对应，只少一个可选的 `sub_task` | `键集:"sends exactly these business keys, in this order"` |
| system prompt 的位置 | 官方同样把 system prompt unshift 成 `messages[0]` 的 `{role:"system", content}`（`JS:132108`），与 `request.ts:197` 一致。`request.ts:193-195` 那条注释的做法是对的——**第二阶段不要把它"修"回顶层 `system` 独占**，顶层 `system` 该补的值见差异第 18 行 | `键集:"keeps the top-level shape when a system prompt is present"` |
| `tools` 元素形状 | `{type:"function", function:{name, description, parameters}}` 的键与键序一致于 OpenAI 约定，`function` 的三个键与 `proto:127-132` 的 `Function` 同名 | `键集:"sends exactly these tools element keys, in this order"`；`键集:"sends exactly these tools element function keys, in this order"`；`键集:"keeps the top-level shape when tools are present"` |

### 面 3：响应流解析

| 项 | 结论 | 验证用例 |
| --- | --- | --- |
| usage 四个字段的取名 | `prompt_tokens` / `completion_tokens` / `total_tokens` / `prompt_tokens_details.cached_tokens` 与官方 `LS` 读的是同一批字段名（`JS:132903`），且两侧都不把 `cacheable_tokens` 当写入量 | `src/__tests__/events.test.ts:"subtracts cached and written tokens from prompt_tokens"` / `"ignores cacheable_tokens, which is a capacity metric not a write count"` / `"defaults every absent field to zero"` / `"never reports negative input when the cache counts exceed prompt_tokens"` |
| `finish_reason` 六个取值的归类 | `stop` / `end_turn` → 正常结束、`length` / `max_tokens` → 长度截断、`tool_calls` / `function_call` → 工具调用，与官方 `GcA`（`JS:132826-132834`）分类一致；而且是显式映射不是 cast（`content_filter` 与未知值的差异见差异第 35 行） | `stream.test.ts:"translates finish_reason instead of passing the upstream vocabulary through"` / `"preserves finish_reason=length instead of overwriting to stop"` / `"emits a done event with reason=length when finish_reason is length"` / `"maps an unrecognised finish_reason to stop"` |
| `[DONE]` 的两种形式与终止后丢弃 | 裸 `[DONE]` 与包在 `{body:"[DONE]"}` 里的形式两侧都识别（官方 `JS:133136`、`JS:132807-132808`；插件 `events.ts:113`、`events.ts:122`），且都在此处停止消费、丢弃其后 payload（官方 `break`，插件 `stream.ts:105-113`） | `stream.test.ts:"finishes on [DONE] without waiting for the server to close the socket"` / `"stops consuming payloads that follow the wrapped [DONE] in the same chunk"` / `"stops consuming payloads that follow a bare data: [DONE] line"` |
| 错误包络终结整轮而不是静默停止 | `statusCodeValue !== 200` 的包络两侧都变成一次真错误（官方 `JS:132794-132805` 抛带 status 的 Error；插件 `events.ts:117-119` → `stream.ts:118-124` 的 `stopReason:"error"` + `error` 事件）。**分类的差异见差异第 34 行**，这里只确认"不会被吞掉" | `stream.test.ts:"surfaces an upstream 406 'Session blocked' as an error event, not a silent stop"` |
| 工具调用分片的组装语义 | `index` 定位、id/name 后到也能补上、参数分片累加、块在调用**可识别**时就开——与官方 `JS:133195-133213` 的 wireIndex→internalIndex 映射同语义（官方多一层块序号偏移，因为它输出 Anthropic 形状的块流） | `stream.test.ts:"reports a tool_use stop reason when the stream emits tool calls"` / `"emits a tool call that arrives with no arguments"` / `"picks up an id and name that arrive after the block is open"` / `"does not claim toolUse when no tool call reached the message"` |
| 跨 chunk 的残余重组 | 两侧都把不完整的尾行留到下一个 chunk（官方 `JS:132670-132675` 留 `K`/`S`；插件 `sse.ts:45` 返回 `rest`），不会把半条 payload 交给解析 | `sse.test.ts:"reassembles a payload that was cut across chunks"` / `"keeps an incomplete trailing line in rest"` / `"returns the whole buffer as rest when there is no line break yet"`；`sse.test.ts` 的 `describe("splitSSEData threads rest across chunks like the pre-optimisation implementation")` 全套 |
| 坏行不杀流 | 单条解析失败只跳过该行（官方 `JS:133152-133155` 计数并 warn；插件 `events.ts:145-150` 在 `QODER_DEBUG` 下打印），两侧都不因此中断整流 | `stream.test.ts:"parses a successful SSE stream into text + stop"`（正常路径）+ 差异第 33 行记的静默跳过就是这条机制的副作用 |

### 面 4：模型目录与配额

| 项 | 结论 | 验证用例 |
| --- | --- | --- |
| 配置 scene 是 `assistant` | 官方 `gU = getClientMetadata().scene`，默认值 `"assistant"`（`JS:106064`、`JS:400-402`、`JS:404`）；插件优先取 `assistant`（`models.ts:173`）。**退到 `chat` 的行为见差异第 41 行** | `models-cache.test.ts:"prefers the assistant scene over chat (qodercli default scene)"` |
| `enable` 的判定 | 官方 `enable !== false && enable !== 0`（`JS:105961`），插件同一条件（`models.ts:181`）：缺 `enable` 字段的条目（dogfood / crit 模型）两侧都保留，显式 `false` 或 `0` 两侧都丢 | `models-cache.test.ts:"keeps entries without an explicit enable flag (dogfood/crit models)"` / `"keeps only enabled service models without adding auto as a fallback"` / `"keeps the Cantus model returned by the current catalog"` / `"filters auto from a legacy fallback cache when the service did not enable it"` |
| 目录条目原样回传 | 插件不解析的目录字段（`strategies` / `promotion` / `price_factor` / `feature_switches` …）仍然整体留在缓存的 `configs` 里并原样回传成 `model_config`（`models.ts:200`、`request.ts:215`），**不构成字段丢失**（见差异第 42 行） | `键集:"sends the cached model config through as model_config, key first"`；`键集:"appends key to the end when the cached config does not have one"` |
| `/api/v2/quota/usage` 是官方同一个端点 | 官方 `fetchQuotaUsage` 打的就是 `<openapi>/api/v2/quota/usage`（`JS:117930`），插件同（`cosy.ts:115-117`）。**响应不解密的差异见差异第 40 行** | `cosy.test.ts:getQoderUsageURL:"constructs correct URL"` |

### 面 5：认证与身份

| 项 | 结论 | 验证用例 |
| --- | --- | --- |
| PAT 交换端点与请求体 | `POST <openapi>/api/v1/jobToken/exchange`，体 `{personal_token}`——官方 `JS:114977`、插件 `cosy.ts:107-109` + `pat.ts:57-68`，端点、方法、体的键名逐字一致 | `cosy.test.ts:getQoderExchangeURL:"constructs correct global URL"` / `cosy.test.ts:getQoderExchangeURL:"constructs correct CN URL"`（**注意**：同名的两条在 `getQoderModelListURL` 那个 describe 下，是 Global Constraints 里记的已知红灯，别搞混）|
| userinfo 端点与鉴权方式 | `GET <openapi>/api/v1/userinfo` + `Authorization: Bearer <jobToken>`——官方 `JS:114998`、插件 `cosy.ts:111-113` + `pat.ts:108-116`。**响应字段读得少的差异见差异第 49 行** | `cosy.test.ts:getQoderUserInfoURL:"constructs correct URL"` |
| PAT 过期后的刷新策略 | 官方 `refreshStrategy: "pat"` 就是重跑 `loginWithPAT`（即重新交换 PAT，`JS:114654`、`JS:115115-115120`），不用 `refresh_token`；插件同样重新 `credentialsFromPat`（`oauth.ts:196-208`） | `oauth.test.ts:"re-exchanges an environment PAT even when a credential is already stored"` |
| machine id 的首选来源 | 两侧都以 `~/.qoder/.auth/machine_id` 为第一来源（官方 `JS:76506`，插件 `cosy.ts:269` 的第一个路径），所以装了 Qoder IDE 的机器上设备指纹天然一致。**推导与落盘的差异见差异第 51 行** | `identity.test.ts:"only the signing path resolves machineID"` |
| 凭据里 userID / machineID 的恢复 | omp 只持久化 access / refresh / expires / email，插件把 userID 与 machineID 编进 refresh 串尾再回读，OAuth 与 PAT 两种布局都覆盖（`oauth.ts:61-69`、`pat.ts:30-48`） | `identity.test.ts:"recovers userID and machineID from the refresh string omp cannot strip"` / `"recovers identity from a PAT refresh string too"`；`pat.test.ts:"encodes and decodes correctly"` / `"handles empty fields"` |

### 面 6：CN 版差异

| 项 | 结论 | 验证用例 |
| --- | --- | --- |
| 签名与请求头没有 CN 分支 | `buildAuthHeaders`（`cosy.ts:287-356`）与 `computeCosySignature`（`cosy.ts:244-263`）都不接受 mode 参数，两个模式共用同一条签名与请求头路径；全仓 `isQoderCNMode` 的分支只落在域名、本地文件名、provider id 与展示名、登录文案、CN 静态目录、模型 key 映射六处 | `src/__tests__/cosy-signature.test.ts:"md5s payload, key, timestamp, body and sigPath joined by newlines"`（签名只吃五个参数，没有 mode）；`锁定:"reproduces the official md5 signature"` |
| CN 的三个域名 | gateway 与 center 都是 `gateway.qoder.com.cn`、openapi 是 `openapi.qoder.com.cn`（`cosy.ts:84`、`cosy.ts:88`、`cosy.ts:92`）。`openapi.qoder.com.cn` 在官方 bundle 里也出现（`JS:119730`，内置 Config SDK 的端点表），可作交叉印证；**gateway 与 center 合一是否正确见面 6 未覆盖** | `cosy.test.ts:getQoderBaseUrl:"returns CN URL for cn mode"` / `getQoderOpenApiUrl:"returns CN URL for cn mode"` / `getQoderCenterUrl:"returns CN URL for cn mode"` |
| CN 的 PAT 与 userinfo 端点 | CN 模式下同样走 `/api/v1/jobToken/exchange` 与 `/api/v1/userinfo`，只是域名换成 `openapi.qoder.com.cn`（`cosy.ts:107-113`） | `cosy.test.ts:getQoderExchangeURL:"constructs correct CN URL"` |

## 收尾：条数统计与第二阶段入口顺序

**行号是稳定标识，故意不重排。**本文件多处按行号交叉引用（"见差异第 2 行"、"与第 19 行一并处理"、"见差异第 49 行"…），一旦按风险重排就会把这些引用全部悄悄指错。所以下面用**分组列出行号**的方式给出入口顺序，行号本身保持不变。

### 按风险分级

| 风险 | 条数 | 行号 |
| --- | --- | --- |
| 高 | 6 | 1、2、3、4、5、7 |
| 中 | 32 | 6、8、9、10、13、14、15、16、17、18、19、20、21、24、25、32、33、34、35、36、38、40、41、44、47、49、50、51、52、53、54、55 |
| 低 | 18 | 11、12、22、23、26、27、28、29、30、31、37、39、42、43、45、46、48、56 |
| **合计** | **56** | |

### 按判定分类

| 判定 | 条数 | 行号 |
| --- | --- | --- |
| 必须对齐 | 45 | 1、2、3、4、5、6、7、8、9、10、11、12、13、14、15、16、17、18、19、20、21、22、24、25、26、29、32、33、34、35、36、37、38、39、40、41、44、47、49、50、51、52、53、54、55 |
| 无需对齐 | 9 | 23、27、28、30、42、43、45、46、48 |
| 不能对齐 | 2 | 31、56 |
| **合计** | **56** | |

### 按面分布

| 面 | 行号区间 | 条数 |
| --- | --- | --- |
| 1 传输层指纹 | 1–15 | 15 |
| 2 请求体构造 | 16–31 | 16 |
| 3 响应流解析 | 32–40 | 9 |
| 4 模型目录与配额 | 41–46 | 6 |
| 5 认证与身份 | 47–53 | 7 |
| 6 CN 版差异 | 54–56 | 3 |

### 第二阶段入口顺序

要做的只有 `必须对齐` 那 45 条（`无需对齐` 9 条与 `不能对齐` 2 条不产生工作量，但**同样要读**——它们和「已验证一致」一起划定了不要去动的范围）。按风险降序：

1. **高风险 6 条：1、2、3、4、5、7。**全部在面 1，全部是纯 bug，全部有锁定用例或向量直接对照。第 1 行修 `cosy.ts:95-101` 就能让 `src/__tests__/cosy.test.ts` 两条已知红灯转绿。第 2、3、4、5、7 行是同一片代码（`cosy.ts:16`、`cosy.ts:336-356`），建议一次改完再跑锁定套件——那三条锁定用例是按"缺失/多发/大小写"三个数组断言的，改一半会让它们从一种红变成另一种红。
2. **中风险 32 条。**按依赖关系分四组：
   - **面 1 剩余（6、8、9、10、13、15）** 与上一步同一片代码，顺路做完。第 15 行（端点发现）做完，第 54 行的 region 问题自动消失。
   - **身份链（14、47、49、50、51）** 必须按 49 → 14 → 50 的顺序：先让 `pat.ts:118-126` 读到 `organization_id` / `organization_tags`，才有东西喂给第 14 行的新明文；第 50 行是把这对值的生命周期从"每请求"改成"每凭据"，依赖第 14 行先定下明文形状。第 47、51 行独立。
   - **面 2（16、17、18、19、20、21、24、25）** 全在 `request.ts` 与 `transform.ts`，`键集:` 那套用例会逐键报错，可以一条一条推。第 24 行要先做，第 39 行才能做（见第 39 行的判定）。
   - **面 3、4、6（32、33、34、35、36、38、40、41、44、52、53、55）** 第 32 行（按事件块分帧）是第 33、34 行的前置——不先把 `event:` 收回来，第 34 行的豁免逻辑无处可写。第 40 行（响应解密）零风险且独立，可以最先做。
3. **低风险且必须对齐 7 条：11、12、22、26、29、37、39。**第 39 行有次序依赖（第 24 行之后），其余随手可做。

**唯一一条建议插队到最前面的是第 40 行（响应解密）**：它对明文恒等，今天零行为变化，改动面只有 `models.ts:166` 与 `usage.ts:50` 两处，却把"服务端改成编码返回"这个随时可能发生的事从"满屏乱码"变成"无事发生"。

### 第二阶段第一批：已改 18 条，**真实网关已验证通过**

`npm test` 359 条全绿、`npm run audit:oracle` 10 条全绿、`npm run lint` 干净、`npm run build` 通过。

**真实网关验证**（`npx tsx scripts/live-alignment-check.ts`，8/8 通过）：
- PAT 重新交换拿到新 token，`userID` 非空 —— 第 49 行的别名改动没有破坏登录链
- `model/list` **200**（65458 字节），auth 类的 19 个头被接受
- `quota/usage` 正常解出 10 个字段
- `agent_chat_generation` **200 并成功流式返回**（13 个分片 / 4117 字符），infer 类的 22 个头被接受
- `Cosy-MachineHostname` 实发 `foot01-s3dev-pod001`（本机主机名 header-safe，走原样透传那条分支）
- 同凭据两次 `buildAuthHeaders` 的 `Cosy-Key` 相同，第 50 行的回放行为在真实调用里成立

也就是说：**升到 1.1.23、改五个头名的大小写、补三个业务标识头、删三个签名辅助头、删组织头与 `X-Request-Id`、按请求类拆分 `Cosy-ClientIp` / `Accept-Encoding`、补 `Connection` 与 `Cosy-MachineHostname`，服务端全部接受，没有 401/403。**

**面 1 的请求头现在与官方逐个头名、逐个大小写一致，两个请求类都对齐了。**锁定套件的
`missing` 数组在 auth 与 infer 两类下都是空数组，`extra` 在 auth 下是空数组、在 infer 下只剩
故意不冻结的 `Cosy-MachineHostname`。

| 行 | 改了什么 | 离线证据 |
| --- | --- | --- |
| 40 | 目录与配额响应过一遍解码（`qoderDecodeBody` / `parseQoderJsonBody`） | 解码器对冻结的官方 WASM 输出逐例还原；`models-cache.test.ts` 用编码正文喂生产路径 |
| 1 | `model/list` 恢复 `/algo` 与 `Encode=1` | `cosy.test.ts` 两条红灯转绿；新增按 `V.catalogRequest.url` 断言的用例 |
| 2 | `Cosy-Version` 1.1.3 → 1.1.23（请求头与被签名载荷两处） | 锁定用例对 `V.inferRequest.headers` 与 `V.signature.payload` 双向断言 |
| 3 | 四个头名改成官方拼法 | 锁定用例的大小写数组在两类下都是空数组 |
| 4 | `Cosy-Machineos` → `Cosy-MachineOS` | 同上 |
| 5 | 补 `Cosy-Business-Product` / `-Type` / `Cosy-Scene` | 锁定用例的缺失数组两类下都空了 |
| 7 | 删 `Cosy-Bodyhash` / `-Bodylength` / `Cosy-Sigpath` | 锁定用例的多发数组 |
| 6 | infer 补 `Connection: keep-alive` | 同上 |
| 8 | 删两个恒空的组织头 | 同上 |
| 9 | 删 `X-Request-Id` | 同上 |
| 10 | `Cosy-ClientIp` 改成只在 auth 类发、值取 machineId | `锁定:"keeps Cosy-ClientIp and Accept-Encoding on the auth class only"` |
| 11 | `Accept-Encoding: identity` 从 infer 挪到 auth | 同上 |
| 12 | auth GET 补 `Content-Type` | 锁定套件现在**两个请求类都比**，这类漏洞不会再有 |
| 13 | infer 发 `Cosy-MachineHostname`，含官方的规范化 | 七条用例覆盖 punycode / slug+hash / 96 字符截断 / 空值不发头 |
| 50 | `info` / `Cosy-Key` 改成每凭据算一次 | 三条用例钉住"同凭据稳定 / 换 token 重算 / requestId 仍每请求变" |
| 49 | userinfo 按官方别名读 uid / name / 组织字段 | 逐别名用例；组织字段穿过凭据交给签名层 |
| 8（修正） | 组织头改成"有组织数据时才发"，不再恒发两个空串 | 预言机实测官方在带组织字段时确实发这两个头，tags 用 `,` 连接 |
| 14 | `info` 明文改成官方四字段，token / name / email 不再进加密载荷 | 用长度反证明文形状（token 加长 400 字节而 info 不变）；**真实网关 200** |

面 1 只剩第 15 行（端点动态发现）未做——它是一个独立特性，不属于头部这批。

**第 14 行已完成并通过真实网关验证。**它原本是这批里唯一无法离线举证的一条：预言机只能证明加密形状，
证明不了服务端解密后读哪些字段，而官方明文里没有 `security_oauth_token`，官方又走另一条登录路径，
不能据此推断插件删掉它也安全。做法是先把可离线举证的 15 条改完、跑通真实网关，再单独改这一条、再跑一次
—— 一次只变一个变量。第二次运行同样 8/8 通过，`model/list` 与 `agent_chat_generation` 都是 200，
**服务端接受了不含 token 的新明文**。

顺带纠正了本轮自己的一处错误结论：第 8 行原先写"官方不发组织头"，那是因为取证时只给 WASM 喂了三段
user-info，而官方交给 `createContext` 的是六段（`JS:114847`）。补齐后实测官方确实发这两个头。教训与
`8c50899` 那次同源 —— 证据不全时得出的否定结论，比没有结论更危险。

验证方法：跑一次正常对话（覆盖 `agent_chat_generation`）、一次 `omp models`（覆盖 `model/list`
与新的解码路径）、一次用量查询（覆盖 `quota/usage`）。要看的是：没有 401/403，模型目录条数与改动前一致，
流式输出正常。

**若出现 401，按嫌疑排序回滚定位**（每条都是独立 commit）：第 2 行（`Cosy-Version` 进了被签名的
载荷，服务端可能校验版本）→ 第 7 行（服务端可能真在读 `Cosy-Bodyhash`）→ 第 9 行（`X-Request-Id`
可能被用于幂等）→ 第 10/11 行（`Cosy-ClientIp` 从 `127.0.0.1` 变成 machineId）。
若只是模型目录变空而请求没报错，先看第 1 行与第 40 行。

### 第二阶段第二批：面 3 响应流解析，已改 6 条

第 32-38 行（第 39 行除外）全部落地。这批是**并行做的** —— 五个 subagent 各领一个切片，契约（新的 `SSEFrame`/`SSEFramer` 接口、`push(frame)` 签名、错误分类要挂哪些字段、哪些官方行为有意不移植）由 controller 先定死写进批次说明，四个切片同时改 `src/events.ts` 零冲突。

| 行 | 改动 | 验证 |
| --- | --- | --- |
| 32 | `sse.ts` 重写为事件块分帧器，保留 `event:`/`id:`，补字节上限 | 21 条用例，含跨 chunk 拼帧、CRLF、心跳空行、只剥一个前导空格 |
| 33 | 四个哨兵显式识别，`[NOTIFICATIONS]#` 报给用户 | 裸串与包一层两种形式；坏 JSON 只 warn 不抛 |
| 34 | 包络判定与错误分类照官方，修掉丢弃无包络 payload 的真 bug | `event: finish` 豁免与裸 499 各一条用例 |
| 35 | 上下文溢出抛 413，`"null"` 不再终止 | 溢出改报错而非静默截断完成 |
| 36 | `reasoning_item` 与 `signature` 两条通道接上 | 打码块 `redacted: true` + 密文进 `thinkingSignature` |
| 37 | 遗留 `function_call` 分片就地合成 | 多片拼接只产生一个调用 |
| 38 | 截断参数先修复再解析，修不好抛错 | 未闭合数组、字符串内含 `}`、转义引号各一条 |

**真实网关端到端已验证**，这是面 3 最强的一档证据：`scripts/live-alignment-check.ts` 的 chat 步现在把服务端字节同时喂给生产的 `SSEFramer` + `QoderEventTranslator`。实测 102 个网络分片 → **58 个事件块** → `thinking_start` + 多条 `thinking_delta` → 文本 `"ok"`、`stopReason=stop`、`terminated=true`。单元测试里的 SSE 都是手写的，只有这一条路径上的帧是服务端真发的。

另有一条组合冒烟（`stream.test.ts` 的 `"face 3 alignment, end to end"`）把六条新行为叠进一条流走真实 `streamQoder`：注释行 + `event:`/`id:` + 心跳空行 + 额度通知 + 两个配额哨兵 + `reasoning_item` + `signature` + 截断的 `function_call`。它防的是**并发编辑把某个调用点悄悄丢掉**，而不是各条语义本身。

### 第二阶段第三批：面 2 请求体构造 11 条 + 面 3 收尾第 39 行

面 2 判定为「必须对齐」的 11 条（第 16-22、24-26、29 行）全部落地，面 3 因此解锁并完成第 39 行。
这一批同样是并行做的：四个 subagent 各领一块有真实逻辑的切片，**顶层 body 字面量由 controller 亲自改** ——
它是一个连续对象，四个 agent 同时重写同一处比重写四个函数危险得多，所以契约里明令禁止他们碰它。

| 行 | 改动 |
| --- | --- |
| 16/17/18/22 | 顶层键序回到官方那一串；删掉 `code_language`/`chat_prompt`/`image_urls`；`system` 发真实 prompt；`chat_context` 键序翻正 |
| 19/21 | effort 改走 `parameters.reasoning_effort` + `enable_thinking`，删掉 `thinking_config.is_default` 与 `thinking_effort` 两条自造通道 |
| 20/29 | `model_config` 改成官方 10 键固定对象；`max_tokens` 兜底 32768 → 32000 并照 `cZ` 语义 |
| 24/26 | assistant 消息改用 `reasoning_content`/`reasoning_content_signature`/`reasoning_item` + `contents`；`tool_calls` 补 `index` |
| 25 | 新增 `applyPromptCacheBreakpoint`，在转换前打 `cache_control: {type:"ephemeral"}` |
| 39 | 删掉 `ThinkingTagParser`（依赖第 24 行先落地） |

**真实网关验证方式本轮升级了。** 之前 live 脚本的 chat 步用的是手搓 body，验的是头集与签名，**根本不经过 `buildChatRequest`** ——
而面 2 改的正是那些进签名载荷的字节，键序错一位就可能 400/401。所以新增了一步：用**生产的**
`buildChatRequest` 造 body 直打网关。实测网关返回 **200** 并完整流式到 `stopReason=stop`，
且打印出的实际形状与官方逐字一致：

```
顶层键序: request_id request_set_id chat_record_id session_id stream chat_task chat_context
          is_reply is_retry source version agent_id task_id session_type aliyun_user_type
          model_config system messages tools parameters business
parameters:      {"max_tokens":32000}
model_config:    key display_name model format is_vl is_reasoning api_key url source max_input_tokens
chat_context:    text features extra chatPrompt imageUrls
```

（官方在 `model_config` 与 `system` 之间还有 `custom_model`，那是 BYOK 专用、本路径恒为 `undefined`，
`JSON.stringify` 会丢掉，所以省略是线上等价的。）

**基线红灯清零。** `src/request.ts:83`/`:146` 那 4 条自 `9f82353` 起就存在的 `TS2367` 全部消失：两条由
`const reasoningVal: unknown` 修掉（原来的比较在类型上恒为 false），另两条随 `thinking_config` 段一起删除。
`npm run check` 现在完全干净。

面 2 剩下的 5 条按台账判定不动：第 23、27、28、30 行「无需对齐」（默认路径两侧一致或插件信息量更全），
第 31 行「不能对齐」（omp 没有 Qoder 的 codebase 索引）。

### 第二阶段第四批：收尾清点（row 15/44/47/51 落定，CN 排除，剩 52/53 留待实测）

用户确认 **CN 相关全部不管**（第 54、55、56 行移出范围；其中第 54 行本与第 15 行联动、第 55 行是 CN
侧真 bug 但不在范围）。本批定案四条、留两条：

| 行 | 结论 | 依据 |
| --- | --- | --- |
| 44 | **已修（被第 20 行顺带消除）** | `buildModelConfig` 只回传固定 10 键，`context_config`/`is_default` 不进 wire，服务端不再收到插件编的 `is_default`。本地「选最大档」保留 |
| 47 | **已修 + 在线验证** | 删掉 PAT 交换的 `Cosy-Version: 1.0.1` 与 `Cosy-ClientType: 5`，PAT 重新交换仍 200。userinfo 本就不发多余头（台账原行号过期） |
| 51 | **已修（推导部分）** | 新增 `deriveMachineIdFromHardware()` 逐行复刻官方公式。但本机 `/sys/class/dmi/id/product_uuid` 是 root-only，Node 插件读不到 → 本机仍回退随机；只在 DMI 可读的部署上生效。官方原子落盘未移植（omp 无并发共享场景） |
| 15 | **改判「无需对齐」** | 发现服务**已实测下线**：v3/v4 × 3 host × `/algo` 前缀 × 带 token 八组合全 404；bundle 的 prod host `api2-v2.qoder.sh` 连 ping 都 404。两个活 region 延迟实质相同（api2 45.2ms / api3 43.7ms），硬编码 api3 无性能损失。发现步骤留在 live 脚本作信息性监控 |

**第 52、53 行有意不改**，理由与最初拦下第 14 行同源：

- 台账第 52 行的判定依据是「插件的刷新端点在官方 bundle 里**命中 0 次**」。这正是本审计要消灭的
  「用 `strings` 命中数下结论」——命中 0 证明不了端点已变，可能只是那条代码路径没被走到。
- 这两条都在 **device-flow 登录路径**上，改错的后果是登录断掉，而我**无法用真实凭据离线验证**
  （device flow 要交互授权）。第 53 行的 `client_id` 与第 52 行的端点体都一样：证据停在字符串搜索层。
- 在能离线举证之前（例如抓一次官方 device flow 的真实请求），这两条维持现状。

### 本轮遗留的待改项

都不在本文件范围内，记在这里免得丢：

- ~~`scripts/cosy-oracle.mjs:31` 的注释断言 `encrypt_user_info` 与 `key` 来自登录响应~~ —— 已随本轮修正（`428e4f0`），注释现在写明官方也是本地生成并附上四条登录路径的行号。
- ~~`scripts/carve-glue.mjs` 的导出清单没带出 wasm-bindgen 模块命名空间~~ —— 已补：carve 现在额外解析底层 snake_case 导出表（锚点 `generate_runtime_auth_fields: () => `，`JS:415`），`scripts/cosy-oracle.mjs` 的 `runtimeAuthFields()` 封装调用形状，第 14、50 行的实测已成两条常驻用例（`npm run audit:oracle` 从 6 条增至 8 条）。
