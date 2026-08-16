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
| 1 | 1 | `model/list` URL | `https://api3.qoder.sh/algo/api/v2/model/list?Encode=1` | `https://api3.qoder.sh/api/v2/model/list`，`/algo` 前缀与 `Encode=1` 都被删（`8c50899` 回归）；`cosy.ts:96-99` 的注释还把这个错误行为标成"反编译实证"，这条假出处正是它活下来的原因 | `V.catalogRequest.url`；`预言机:"adds the /algo prefix and keeps Encode=1 on the model catalog request"`；`src/cosy.ts:95-101`。`src/__tests__/cosy.test.ts:92-100` 两条红用例断言的是**正确**值，修 `cosy.ts` 即转绿 | 高 | 必须对齐 |
| 2 | 1 | `Cosy-Version` 与签名载荷 `cosyVersion` | 均为 `1.1.23`，取 package 版本（`JS:69503` `CUH = P9A \|\| "1.1.23"`） | 均硬编码 `1.1.3`：`cosy.ts:16` 一个常量喂两处——请求头 `cosy.ts:340` 与签名载荷 `cosy.ts:318`。**版本号因此也进了被签名的 payload** | `V.inferRequest.headers["Cosy-Version"]`、`V.signature.payload.cosyVersion`；`锁定:"still pins a stale Cosy-Version"` | 高 | 必须对齐 |
| 3 | 1 | WASM 头大小写 | `Cosy-MachineId` / `Cosy-MachineToken` / `Cosy-MachineType` / `Cosy-ClientType` | `Cosy-Machineid` / `Cosy-Machinetoken` / `Cosy-Machinetype` / `Cosy-Clienttype`（`cosy.ts:341-345`） | `锁定:"still spells these headers with different casing than the official client"` | 高 | 必须对齐 |
| 4 | 1 | `Cosy-MachineOS` 大小写 | 官方**在 JS 层**注入，不在 WASM 里：`JS:69460` 用大小写无关的"不存在才写"helper（`JS:69431`）写入 `JS:69487` 的常量 `x86_64_linux`；model-list（`JS:105910`）与 infer-sse（`JS:146170`）都传 `injectClientIdentityHeaders: !isServiceAccount()`，普通用户为 true | `Cosy-Machineos`（`cosy.ts:344`），值的计算方式一致 | `V.inferRequest.headerNames`（含 `Cosy-MachineOS`，由 `scripts/freeze-vectors.mjs:36` 按上述行号合并进来）；`锁定:"still spells these headers with different casing than the official client"` | 高 | 必须对齐 |
| 5 | 1 | 业务标识头缺失 | `Cosy-Business-Product: cli`、`Cosy-Business-Type: agent`、`Cosy-Scene: assistant`（两类请求都发） | 三个都不发 | `V.inferRequest.headers`、`V.catalogRequest.headers`；`锁定:"still misses exactly these official headers"`；`预言机:"emits the business identity headers on the infer request"` | 高 | 必须对齐 |
| 6 | 1 | `Connection` | infer 带 `Connection: keep-alive` | 不发（`transport.ts:201-209`） | `V.inferRequest.headers.Connection`；`锁定:"still misses exactly these official headers"` | 中 | 必须对齐 |
| 7 | 1 | 多发签名辅助头 | 两类请求都不发 `Cosy-Bodyhash` / `Cosy-Bodylength` / `Cosy-Sigpath` | 三个都发（`cosy.ts:347-349`）。它们把签名的中间量摊在明文头里，是最显眼的非官方特征 | `V.inferRequest.headerNames`、`V.catalogRequest.headerNames` 均无；`锁定:"still sends exactly these headers the official client does not"` | 高 | 必须对齐 |
| 8 | 1 | 多发空值组织头 | 在本审计的取证身份下不发 `Cosy-Organization-Id` / `Cosy-Organization-Tags`（官方的组织相关头走另一条 codebase 路径，`JS:146167-146169`，且只对 target organization 生效） | 恒发两个空字符串（`cosy.ts:351-352`） | `V.inferRequest.headerNames`、`V.catalogRequest.headerNames` 均无；`锁定:"still sends exactly these headers the official client does not"` | 中 | 必须对齐 |
| 9 | 1 | 多发 `X-Request-Id` | 只在 `endpointType === "openapi"` 或 host 含 `openapi` 时写 `X-Request-ID`（`JS:68585`、`JS:68592`、`JS:68607-68610`，头名常量 `JS:68612`）。`api3.qoder.sh` 上的 model-list 与 infer 都是 `endpointType: "infer"`，两者都不写 | 恒发 `X-Request-Id`（`cosy.ts:354`），大小写也与官方的 `X-Request-ID` 不同 | `V.inferRequest.headerNames`、`V.catalogRequest.headerNames` 均无；`锁定:"still sends exactly these headers the official client does not"` | 中 | 必须对齐 |
| 10 | 1 | `Cosy-ClientIp` | **按请求类不同**：auth GET 发，值等于 machineId；infer 不发 | 两类都发，值恒为 `127.0.0.1`（`cosy.ts:346`） | `V.catalogRequest.headers["Cosy-ClientIp"]` = machineId；`V.inferRequest.headerNames` 无此项；`预言机:"emits the business identity headers on the infer request"` 显式断言 infer 上为 undefined；`锁定:"still sends exactly these headers the official client does not"` | 中 | 必须对齐 |
| 11 | 1 | `Accept-Encoding` | **按请求类不同**：auth GET 带 `identity`，infer 不带 | 正好反了：infer 带（`transport.ts:205`），model-list 不带（`models.ts:153-160` 只并入 `Accept`） | `V.catalogRequest.headers["Accept-Encoding"]` = `identity`；`V.inferRequest.headerNames` 无此项；`锁定:"still sends exactly these headers the official client does not"` | 低 | 必须对齐 |
| 12 | 1 | auth GET 的 `Content-Type` | 即使是无体 GET 也带 `Content-Type: application/json` | model-list 不带（`models.ts:153-160`）。**该差异不在锁定套件里**——锁定套件只比 infer 类 | `V.catalogRequest.headers["Content-Type"]` | 低 | 必须对齐 |
| 13 | 1 | `Cosy-MachineHostname` | 仅 `requestClass === "infer-sse"` 时发（`JS:69460-69462`），且主机名必须 header-safe：不安全时 `JS:69407`→`JS:69383` 会规范化甚至省略并打 warn | 从不发 | `JS:69460-69462`、`JS:69407`、`JS:69383-69386`；**故意不冻结进向量**（值随机器变化，冻结会让测试在别的机器上红，见 `scripts/freeze-vectors.mjs:23-34`） | 中 | 必须对齐 |
| 14 | 1 | `info` / `Cosy-Key` 来源 | 架构性差异：登录响应下发 `encrypt_user_info` 与 `key`，客户端此后**原样回放**，不做任何本地加密 | 本地现算：AES-CBC 加密 userInfo 得 `info`、RSA 加密 AES key 得 `Cosy-Key`（helper `cosy.ts:212-226`，调用点 `cosy.ts:299`、`cosy.ts:308-309`） | `预言机:"replays the credential-supplied user info and key verbatim"`（喂 `EUI`/`KEY123` 原样出现在 `Authorization` 载荷与 `Cosy-Key`）；`scripts/cosy-oracle.mjs:31-32` | 中 | **待定：依赖面 5**——插件是否拿得到官方登录响应里的那两个字段，要等 Task 8 的面 5（PAT→jobToken 交换与 `/api/v1/userinfo` 返回体）确认。拿不到即 `不能对齐`，拿得到即 `必须对齐`。不要在这里猜 |
| 15 | 1 | 端点解析 | 动态发现：`/api/v3/service/region/endpoints` 与 `/api/v4/service/region/endpoints`，配 `/algo/api/v1/ping` 健康检查与端点缓存（`JS:77297`） | 硬编码 `api3.qoder.sh` / `gateway.qoder.com.cn`（`cosy.ts:83-93`） | `JS:77297` | 中 | 必须对齐（无阻碍：同一套凭据即可调该端点） |

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
| 16 | 2 | 顶层键序 | `chat_context` 在第 7 位（紧跟 `chat_task`）、`model_config` 第 16、`session_type` 在 `task_id` 之后 | `chat_context` 被排到第 22、`model_config` 第 23、`session_type` 提到 `agent_id` 之前 | `JS:132123` vs `request.ts:175-225` + `键集:"sends exactly these top-level keys, in this order"` | 中 | 必须对齐 |
| 17 | 2 | 插件多发的顶层键 | 没有 `code_language`、`chat_prompt`、`image_urls` 这三个顶层键（`code_language` 与 `thinking_effort` 两个字面量在整个官方 bundle 里 0 命中） | 恒发 `code_language: ""`、`chat_prompt: ""`、`image_urls: null`（`request.ts:189-191`）。官方的对应概念在 `chat_context.chatPrompt` / `chat_context.imageUrls` 里 | `JS:132123`、`JS:132178`；`键集:"sends exactly these top-level keys, in this order"` | 中 | 必须对齐 |
| 18 | 2 | 顶层 `system` 取值 | 发真实 system prompt（`system: A11 ?? ""`），**同时**把它 unshift 成 `messages[0]` 的 system 消息 | 恒发 `system: ""`，只走 messages 一路（`request.ts:193-197`）。注释说"服务端忽略顶层 system"——这不假，但官方照样发；一个 `system` 为空而 `messages[0].role === "system"` 的请求是可区分特征 | `JS:132123`、`JS:132108`；`键集:"keeps the top-level shape when a system prompt is present"` | 中 | 必须对齐 |
| 19 | 2 | reasoning effort 的载体 | 写进 `parameters`：`reasoning_effort`（字符串）、`enable_thinking`（bool）、`reasoning_budget_tokens`（int）、`preserve_thinking`（`JS:121996-122003`、`JS:132112-132118`） | 完全不用这条通道：改去补 `model_config.thinking_config.{disabled,enabled}.…is_default`（`request.ts:142-173`）。词表本身是对的（官方 `none\|low\|medium\|high\|xhigh\|max`，`JS:85158-85166`，与 `proto:13-21` 的 `ReasoningEffort` 同名；插件 `request.ts:85-86` 用同一组、把 `minimal` 折成 `low`），错的是通道——服务端很可能整段忽略，effort 与 `--thinking off` 都静默失效 | `JS:121989-122005`、`JS:132110-132121`；`键集:"sends exactly these parameters keys"`（钉住插件 `parameters` 只有 `max_tokens`） | 中 | 必须对齐 |
| 20 | 2 | `model_config` 内容 | 现造一个固定 10 键对象：`{key, display_name, model:"", format, is_vl, is_reasoning, api_key:"", url:"", source, max_input_tokens}`。**不含 `thinking_config`** | 把目录缓存条目原样回传（服务端下发的任何字段都在里面），只覆写 `key`、再往 `thinking_config` 里塞 `is_default`（`request.ts:66-76`、`request.ts:142-173`、`request.ts:215`） | `JS:132131` vs `键集:"sends the cached model config through as model_config, key first"` / `键集:"appends key to the end when the cached config does not have one"` | 中 | 必须对齐 |
| 21 | 2 | `chat_context.extra.modelConfig.thinking_effort` | 无此字段（`chat_context` 只有 `JS:132178` 的固定形状；`thinking_effort` 字面量在官方 bundle 里 0 命中） | 有 effort 时插入（`request.ts:208`） | `JS:132178`；`键集:"sends exactly these chat_context.extra.modelConfig keys, in this order"` | 中 | 必须对齐（与第 19 行一并处理） |
| 22 | 2 | `chat_context` 键序 | `{text, features, extra, chatPrompt, imageUrls}` | `{chatPrompt, imageUrls, extra, features, text}`——五个键同名同值，顺序整个反过来（`request.ts:200-214`） | `JS:132178`；`键集:"sends exactly these chat_context keys, in this order"` | 低 | 必须对齐 |
| 23 | 2 | `chat_context.text` / `originalContent` 取值 | 最后一条 user 消息的 content，且**只在它是 string 时**取，否则空串（`JS:132170-132176`） | 数组 content 也会把 text 段拼起来（`request.ts:105-110`），带图片的轮次两侧结果不同 | `JS:132170-132176` vs `request.ts:101-113` | 低 | 无需对齐（值差异不改变服务端解析路径，且插件这版信息量更全） |
| 24 | 2 | assistant 消息的 reasoning 字段 | 独立字段承载：`reasoning_content`、`reasoning_content_signature`、`reasoning_item`，另有与 `content` 并存的 `contents` 分块数组（`JS:111995-112006`）；`proto:59-74` 的 `ChatMessage` 也声明了 `reasoning_content` / `reasoning_item` | 把 thinking 内联成字面量 `<thinking>…</thinking>\n\n` 拼进 `content`（`transform.ts:143-144`），不发 `contents`，也不回传 signature | `JS:111965-112006`、`proto:59-74` vs `transform.ts:33-39`、`transform.ts:133-173` | 中 | 必须对齐（服务端已声明这些字段；把推理文本混进 content 还会教模型继续吐标签，而插件正为此维护 `ThinkingTagParser`——因果关系待面 3 确认，此处不作结论） |
| 25 | 2 | prompt cache 断点 | 在最后一条（`skipCacheWrite` 时是倒数第二条）消息的最后一个非 thinking/tool 块上打 `cache_control: {type:"ephemeral"}`（`JS:102851-102869`），user/assistant 的文本块也逐块透传 `cache_control`（`JS:111938-111940`、`JS:111972-111974`） | 从不发 `cache_control`（`transform.ts:29-39` 的 part 类型里没有这个字段） | `JS:102851-102869`、`JS:111938-111940`、`JS:111972-111974`、`proto:91-93` | 中 | 必须对齐 |
| 26 | 2 | `tool_calls` 元素缺 `index` | `{id, type:"function", index, function:{name, arguments}}`（`JS:111990`） | `{id, type:"function", function:{…}}`，无 `index`（`transform.ts:23-27`、`transform.ts:147-155`） | `JS:111990` vs `transform.ts:147-155` | 低 | 必须对齐 |
| 27 | 2 | `business` 的可选子字段 | `business` 本身是条件键（`JS:132123` 的 `...W !== void 0 ? {business:W} : {}`）；`proto:193-202` 另声明 `sub_task`，`JS:146170` 证明 gateway body 确实会带它；目录条目有 `function_switches` 且调用方给了选择时还会追加 `business.feature_switches`（`JS:132125-132128`、`JS:105108-105116`） | 恒发 7 键，无 `sub_task`、无 `feature_switches`（`request.ts:216-224`） | `JS:132123`、`JS:132125-132128`、`JS:146170`、`proto:193-202`；`键集:"sends exactly these business keys, in this order"` | 低 | 无需对齐（默认路径官方也不带这两个子字段） |
| 28 | 2 | 采样旋钮全缺 | `parameters` 可带 `temperature` / `top_p` / `top_k` / `tool_choice` / `context_length`，但**只在用户配置了 generation 偏好时**才写（`JS:121992-121995`、`JS:132120-132121`）；默认路径不写 | 永不写（`request.ts:199`，`parameters` 只有 `max_tokens`） | `JS:121989-122005`、`JS:132110-132121`；`键集:"sends exactly these parameters keys"` | 低 | 无需对齐（默认路径两侧一致；omp 也不暴露这些旋钮） |
| 29 | 2 | `max_tokens` 兜底常数 | proto 用 `google.protobuf.Int32Value`（wrapper，语义是"缺省可与 0 区分"），但官方 gateway 侧恒发裸整数并兜底：`cZ()` 在值非正整数时回落 **32000**（`JS:105458-105461`、`JS:132111`） | 同样恒发裸整数，兜底 **32768**（`request.ts:73`、`request.ts:129-135`） | `proto:31`、`JS:105458-105461`、`JS:132111` vs `request.ts:129-135`；`src/__tests__/request-body.test.ts` 的 `describe("buildChatRequest clamps a bad cached max_output_tokens")` 九条用例钉住插件的兜底 | 低 | 必须对齐 |
| 30 | 2 | `tools` 元素的 schema 声明字段 | `proto:118-132` 的 `Tool` 声明 `cache_id`、`function.strict`、`advisor`。官方 gateway body 的 `tools` 由调用方传入（`JS:132123` 的 `E?.tools ?? []`），本轮**没有**取到它的构造点，所以只能作 schema 级陈述 | 只发 `{type:"function", function:{name, description, parameters}}`（`transform.ts:61-70`） | `proto:118-132`；`键集:"sends exactly these tools element keys, in this order"` / `键集:"sends exactly these tools element function keys, in this order"` | 低 | 无需对齐（无证据表明官方实际发这三个字段） |
| 31 | 2 | `metadata.workspace` / `metadata.user` | `proto:174-190`、`proto:215-217` 声明 `WorkspaceMetadata`（`file_count`/`languages`/`codebase_status`/`codebase_soft_status`/`codebase_external_id`/`data_policy`）与 `UserMetadata{user_id}` | 无任何承载字段 | `proto:174-190`、`proto:215-217`；`键集:"sends exactly these top-level keys, in this order"` | 低 | 不能对齐（omp 没有 Qoder 的 codebase 索引，这些 workspace 指标无从产出；`data_policy` 已由 `Cosy-Data-Policy` 头覆盖，`user_id` 已由 `Cosy-User` 头覆盖） |

#### 面 2 未覆盖

- **官方 `tools` 与 `business` 的构造点**。两者在 `JS:132123` 都是调用方传入的参数，本轮没有回溯到源头，所以第 27、30 行只给了 schema 级或条件级结论。
- **`stream_options.include_usage`**。两侧都不发；插件确实收到了 usage（`events.ts:53-63` 记录了实测到的字段子集，`src/__tests__/stream.test.ts:"captures usage, responseId and responseModel from the finish chunk"` 钉住映射），所以缺这个字段目前没有可观测后果。是否有边缘情况属面 3。
- **`messages` 的完整变换链**。官方在 `DuA`（`JS:112273-112286`）之前还过 `KPH`，之后 assistant/user 各走 `kCQ`/`zCQ`；本轮只核对了 reasoning 字段、`contents`、`cache_control`、`tool_calls.index` 四处，没有逐块比对 tool_result 与图片的编码。

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
| `Cosy-Data-Policy` | 头名与大小写一致（它不出现在三个已知差异数组里，即已被三条锁定用例共同排除）。值 `disagree` 也一致——这一半是 `V.inferRequest.headers["Cosy-Data-Policy"]` 与 `cosy.ts:18` 的字面对照，没有单独用例 | `锁定:"still misses exactly these official headers"` + `"still sends exactly these headers the official client does not"` + `"still spells these headers with different casing than the official client"` |
| 请求体混淆编码 | `qoder-encoding.ts` 与 WASM 输出**逐字节相同**，覆盖 64 B JSON、1008 B、`{}`、含中文与 emoji 四组输入 | `锁定:"matches the wasm output byte for byte (case 0..3)"`（四条）；`预言机:"obfuscates the infer body inside the wasm"`（另钉住 `4*ceil(n/3)` 的长度关系） |
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
