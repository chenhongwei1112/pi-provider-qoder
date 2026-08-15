# pi-provider-qoder 结构性重构设计

日期:2026-08-14
状态:阶段一已实施(21 commits,`e22bd20..d6a58c8`)

> 本文写于实施前。若某处对接口的描述与源码不符,以源码为准 —— 偏差清单见
> `docs/superpowers/plans/2026-08-14-qoder-structural-refactor.md` 的「实施后偏差」一节。
> 与本文直接有关的一处:`QoderModelEntry` 最终留在 `models.ts` 而非 `models-static.ts`(`:68,357`)。

## 背景

`ad1b547` 与 `47bd26d` 修掉了流式层的六个正确性缺陷。修复过程暴露出一个共同成因:关键不变量从未被写下来,于是每次线上出问题就打一个局部补丁,补丁又落在同一批过大的文件里。

当前规模:

| 文件 | 行数 | 承担的职责数 |
| --- | ---: | ---: |
| `src/stream.ts` | 880 | 4(传输重试、请求体构造、SSE 解析、事件发射) |
| `src/models.ts` | 562 | 2(静态目录数据 380 行 + 缓存逻辑 180 行) |

改动成本的具体表现:调整重试策略必须读 SSE 解析代码,反之亦然;SSE 行切分与 usage 映射这两处易错逻辑无法单独测试。

## 目标

降低下次改动的成本。具体可验证的标准:

1. `stream.ts` 降到约 90 行,只做编排
2. 每个新模块能独立阅读、独立测试,且能回答"它做什么、怎么用、依赖什么"
3. SSE 行切分与 usage 映射从"只能通过跑一整条 SSE 流间接覆盖"变为可直接表驱动测试
4. 身份 fallback 逻辑从 4 处收敛到 1 处

## 非目标

- 不为任何特定的未来改动方向预留扩展点(YAGNI)
- 不回上游 PR,因此不受 diff 大小与文件布局的兼容性约束
- 不做与本目标无关的重构
- 阶段一不改变任何运行时行为

## 范围与阶段划分

两个阶段严格分离,因为纯重构的正确性证明依赖"行为不变"这一前提。混在一起做,测试失败时无法区分是搬移搬错了还是行为改动引入的。

### 阶段一:纯重构,行为零变化

1. `stream.ts` 拆分为 `stream.ts` + `transport.ts` + `request.ts` + `events.ts` + `sse.ts`
2. `models.ts` 拆分为 `models.ts` + `models-static.ts`
3. 身份 fallback 逻辑抽取为 `resolveQoderIdentity`,消除 4 处重复
4. `stableHash` 与 `stableChatRecordID` 两份同模式实现合一
5. 清理死代码:`maxTokens` 恒真分支、`completion_tokens_details.reasoning_tokens` 未使用字段声明

### 阶段二:行为变更,每项配独立测试

1. `getCachedCredentials` 忽略首参导致的 uid/token 错配
2. 扩展加载时 3 次串行网络阻塞
3. `QODER_MODE=cn` 时的重复 provider 条目
4. `Accept-Encoding: identity`(先实验验证再决定)

本设计文档只完整定义阶段一。阶段二在本文末尾记录方向与已知风险,实施前需另出设计。

## 架构

### 目标文件布局

| 文件 | 职责 | 现状 → 目标行数 |
| --- | --- | --- |
| `index.ts` | 扩展注册、provider 配置 | 121 → ~95 |
| `stream.ts` | 编排:解析身份 → 造请求 → 开流 → 喂状态机 | 880 → ~90 |
| `transport.ts` | 重试、watchdog、错误链、`Retry-After`、`openQoderStream` | 新增 ~210 |
| `request.ts` | reqBody 构造、稳定 ID 生成 | 新增 ~150 |
| `events.ts` | envelope 解包 → pi 事件的状态机、`mapUsage` | 新增 ~300 |
| `sse.ts` | SSE 行切分(纯函数) | 新增 ~40 |
| `models-static.ts` | 静态模型表、`QoderModelDef`、`QoderModelEntry`、`ZERO_COST` | 新增 ~385 |
| `models.ts` | 缓存读写、目录抓取、friendly 查询 | 562 → ~180 |
| `oauth.ts` | 凭证编排 + 新增 `identityFromCredentials`、`resolveQoderIdentity` | 227 → ~270 |
| `cosy.ts` | 端点、签名、region 判定 + 新增 `QoderIdentity`、`qoderIdentityDefaults` | 310 → ~330 |
| `transform.ts` | 不动 | 215 |
| `thinking-parser.ts` | 不动 | 244 |
| `pat.ts` | 仅改两行以复用 `qoderIdentityDefaults` | 153 |
| `login.ts` `usage.ts` `qoder-encoding.ts` | 不动 | — |

### 依赖方向

```
index.ts ──→ stream.ts ──→ transport.ts ──→ cosy.ts
   │            │      ──→ request.ts   ──→ transform.ts
   │            │                       ──→ models.ts ──→ models-static.ts ──→ cosy.ts
   │            │                       ──→ qoder-encoding.ts
   │            │      ──→ events.ts    ──→ thinking-parser.ts
   │            │      ──→ sse.ts       (零依赖)
   │            └──────→ oauth.ts       ──→ pat.ts, login.ts, models.ts
   ├──→ models.ts
   ├──→ models-static.ts
   ├──→ oauth.ts
   └──→ usage.ts
```

无环。`cosy.ts` 是被广泛依赖的叶子(端点、签名、region 判定)。`sse.ts` 零依赖。

### 两条关键边界

这是本次拆分真正买到的东西:

- **`transport.ts` 不引用任何 pi 类型。** 输入 `Buffer` 与凭证,输出 `ReadableStreamDefaultReader<Uint8Array>` 及配套的 watchdog 控制句柄。因此重试与超时策略能脱离 pi 的类型体系单独推理和测试。
- **`events.ts` 不引用 `fetch`。** 输入 SSE `data:` 载荷字符串,输出 pi 事件。因此 SSE 语义能脱离网络单独测试。

现状是这两块互相纠缠在同一个 880 行文件里。

## 模块接口

### `sse.ts`

```ts
export interface SSESplit {
  /** `data:` payload values, already trimmed, in arrival order. */
  payloads: string[];
  /** Unconsumed tail: an incomplete final line, kept for the next chunk. */
  rest: string;
}

export function splitSSEData(buffer: string): SSESplit;
```

行为必须与现有内联逻辑逐条等价:

1. 按 `\n` 切行
2. 每行 `trim()`
3. 丢弃不以 `data:` 开头的行
4. 保留行的第 5 字符之后的内容,再 `trim()`
5. 末尾不完整的行(无结尾 `\n`)放入 `rest`

此外还有一处纯性能改动:现有代码每消费一行执行一次 `buffer = buffer.substring(lineEnd + 1)`,含 k 行的 chunk 要复制剩余部分 k 次,可改为单趟扫描 + 索引推进、末尾只切一次。该优化**不在拆出 `sse.ts` 的那个 commit 内完成** —— 拆出时先原样搬移上述五条逻辑,优化单独成 commit(见"实施顺序"第 7 步),以免搬移与改写混在一次提交里无法二分定位。

### `events.ts`

```ts
export class QoderEventTranslator {
  constructor(
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    options: { thinkingEnabled: boolean },
  );

  /**
   * Feed one SSE `data:` payload.
   * Returns "done" when the terminator arrived, "continue" otherwise.
   * Malformed JSON is skipped (logged under QODER_DEBUG).
   * An upstream error envelope throws.
   */
  push(payload: string): "continue" | "done";

  /**
   * Close open blocks, finalise tool calls, decide the stop reason.
   * Throws when upstream promised tool_calls and sent none.
   */
  finalize(): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">;
}

/** OpenAI `usage` → pi's usage fields. Exported for direct testing. */
export function mapUsage(
  raw: QoderUsage,
): Pick<AssistantMessage["usage"], "input" | "output" | "totalTokens" | "cacheRead" | "cacheWrite">;

/** The subset of OpenAI's `usage` object Qoder actually sends. */
export interface QoderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cacheable_tokens?: number;
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}
```

私有状态即当前散在 `streamQoder` 闭包中的五项:`contentBlockIndex`、`thinkingBlockIndex`、`toolCallsState`、`thinkingParser`、`finish_reason` 映射结果。

`push()` 的分派语义,与现有代码一一对应:

| 输入 | 返回/动作 |
| --- | --- |
| 裸 `[DONE]` | `"done"` |
| JSON 解析失败(`SyntaxError`) | 跳过,`QODER_DEBUG` 下打日志,`"continue"` |
| `statusCodeValue` 存在且 ≠ 200 | 抛错 |
| `body === "[DONE]"` | `"done"` |
| `body` 为空 | `"continue"` |
| 其余 | 解析 inner,处理 usage / choices / delta,`"continue"` |

两个设计决定:

- **`finalize()` 返回 reason,不自己 push `done` 事件。** `error` 路径在编排层的 `catch` 中,终止事件的发射必须集中在一处,否则"谁负责结束流"会分裂成两个答案。
- **envelope 解包归 `events.ts`,不归 `sse.ts`。** `{ headers, body, statusCodeValue }` 是 Qoder 的包裹格式而非 SSE 协议的一部分。`sse.ts` 只懂 SSE,可用于任何 SSE 服务;`events.ts` 懂 Qoder。

`push()` 的返回类型采用字符串联合而非 `boolean`:调用点写作 `=== "done"` 时自解释,`if (translator.push(p))` 则需回查签名才知道 `true` 的含义。

### `transport.ts`

从 `stream.ts` 原样迁出,不改逻辑:

```ts
export interface OpenStreamRequest {
  chatURL: string;
  encodedBytes: Buffer<ArrayBuffer>;
  qoderModel: string;
  modelSource: string;
  callerSignal?: AbortSignal;
  creds: { userID: string; authToken: string; name: string; email: string; machineID: string };
}

export interface OpenedQoderStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  firstChunk: Uint8Array;
  armIdleWatchdog: () => void;
  disarmWatchdog: () => void;
  describeStreamError: (error: unknown) => Error;
}

export function openQoderStream(request: OpenStreamRequest): Promise<OpenedQoderStream>;
```

同时迁出的内部实现:`MAX_SEND_ATTEMPTS`、`FIRST_PAYLOAD_TIMEOUT_MS`、`STREAM_IDLE_TIMEOUT_MS`、`RETRY_BASE_DELAY_MS`、`RETRY_MAX_DELAY_MS`、`RETRYABLE_ERROR_CODES`、`RETRYABLE_STATUSES`、`RETRYABLE_ERROR_MESSAGES`、`ErrorLink`、`errorChain`、`isRetryableTransportError`、`formatTransportError`、`parseRetryAfterMs`、`sleep`。

### `request.ts`

```ts
export interface QoderChatRequest {
  encodedBytes: Buffer<ArrayBuffer>;
  qoderModel: string;
  modelSource: string;
  chatURL: string;
}

export function buildChatRequest(args: {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  providerMode: string;
  identity: QoderIdentity;
}): QoderChatRequest;
```

内部承担:`qoderModel` 解析(CN 直连映射)、`modelConfig` 解析与 fallback、`transformMessagesForQoder` / `transformTools` 调用、`lastUserText` 提取、`sessionID` 与 `recordID` 生成、reqBody 组装、`JSON.stringify` + `qoderEncodeBodyToBuffer`。

`stableHash` 与 `stableChatRecordID` 合并为单一实现:

```ts
/** First 16 hex chars of sha256 over a domain prefix plus NUL-separated parts. */
function stableID(prefix: string, parts: Iterable<string>): string;
```

`stableChatRecordID` 改为该函数的调用方,构造其 parts 序列。合并后行为必须与现有两个函数逐字节一致 —— 两者本就是同一模式(prefix + `\0` 分隔 + sha256 + 取前 16 位十六进制字符),实施时以固定输入对照旧实现确认。

### 身份解析抽取(分放 `cosy.ts` 与 `oauth.ts`)

**归属必须分两处,否则成环。** `oauth.ts:9` 已 import `pat.js`,而 `pat.ts` 需要复用同一套默认值 —— 若把默认值放进 `oauth.ts`,`pat.ts` 反向 import 就形成 `oauth → pat → oauth` 循环。`cosy.ts` 是所有模块的叶子(零项目内 import),且已导出这两个函数需要的 `isQoderCNMode` 与 `getQoderUserEmailFallback`,故类型与默认值归它。

`cosy.ts` 新增:

```ts
/** Identity fields COSY signing needs. */
export interface QoderIdentity {
  userID: string;
  name: string;
  email: string;
  machineID: string;
}

/** The placeholders used when the auth store has no answer. */
export function qoderIdentityDefaults(mode: string): Omit<QoderIdentity, "machineID">;
```

`oauth.ts` 新增(需要 `getCachedCredentials`,故留在此处):

```ts
/** Fill an already-loaded credentials object's gaps with the defaults. */
export function identityFromCredentials(
  creds: Partial<QoderIdentity> | null | undefined,
  mode: string,
): QoderIdentity;

/** Read the identity from pi's auth store, falling back to placeholders. */
export function resolveQoderIdentity(providerID: string, mode: string): QoderIdentity;
```

**为何需要 `identityFromCredentials` 这第三个函数:** `index.ts:74-79` 已经持有 credentials 对象,若改走 `resolveQoderIdentity` 会重新读一次 `auth.json` —— 那是行为变化(多一次文件 I/O,且 `autoLoginQoderFromEnvironment` 刚写入的凭证与内存对象未必同步)。`resolveQoderIdentity` 因此实现为 `identityFromCredentials(getCachedCredentials("", providerID), mode)`。

消除的 4 处重复:

| 位置 | 现状 |
| --- | --- |
| `index.ts:75-77` | `refreshModelsAtStartup` 中的三行 fallback |
| `index.ts:109-111` | `session_start` 回调中的同样三行 |
| `stream.ts:420-423` | 同样三行 + `machineID` fallback |
| `pat.ts:149-150` | 语义不同(新建凭证填默认值),但默认值定义相同 |

`index.ts:108-112` 与 `stream.ts:420-423` 改为调用 `resolveQoderIdentity`(二者本就要从 auth 存储读);`index.ts:74-79` 改为调用 `identityFromCredentials`(它已持有对象);`pat.ts` 复用 `qoderIdentityDefaults` 取默认值,保持其"新建凭证"的语义不变。

`resolveQoderIdentity` 保持 `getCachedCredentials` 忽略 accessToken 首参的现有行为,以维持阶段一的行为零变化。修正该问题属阶段二第 1 项,届时只需改这一处 —— 这正是本次抽取的收益。

### 编排后的 `stream.ts` 核心循环

`identity` 与 `creds` 的关系需明确,因为两个模块要的东西不同:`buildChatRequest` 只需身份字段(`QoderIdentity`),而 `openQoderStream` 的 COSY 签名还需要 `authToken`。编排层负责合并,`authToken` 来自 `options.apiKey`,不进入 `QoderIdentity`:

```ts
const identity = resolveQoderIdentity(model.provider, providerMode);
const request = buildChatRequest({ model, context, options, providerMode, identity });
opened = await openQoderStream({
  ...request,
  callerSignal: options?.signal,
  creds: { ...identity, authToken: accessToken },
});
```

这条边界的意义:身份解析(`oauth.ts`)不接触 token 的传输用途,签名(`transport.ts` → `cosy.ts`)不关心身份是从哪解析出来的。

```ts
const translator = new QoderEventTranslator(output, stream, { thinkingEnabled });
stream.push({ type: "start", partial: output });

let buffer = "";
let finished = false;
let pending: Uint8Array | undefined = opened.firstChunk;

while (!finished) {
  let chunk: Uint8Array;
  if (pending) {
    chunk = pending;
    pending = undefined;
  } else {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (e) {
      throw describeStreamError(e);
    }
    if (result.done) break;
    chunk = result.value;
    armIdleWatchdog();
  }

  buffer += decoder.decode(chunk, { stream: true });
  const { payloads, rest } = splitSSEData(buffer);
  buffer = rest;

  for (const payload of payloads) {
    if (translator.push(payload) === "done") {
      finished = true;
      break;
    }
  }
}

stream.push({ type: "done", reason: translator.finalize(), message: output });
stream.end();
```

`finally` 中的 `opened?.disarmWatchdog()` 与 `catch` 中的 error 事件发射保持不变。

## `models.ts` 拆分

`models-static.ts` 收:`ZERO_COST`、`QoderModelEntry`、`QoderModelDef`、`staticModels`(15 条)、`staticCnModels`(9 条)。约 385 行,其中 380 行为数据。

`models.ts` 留:`getQoderCachePath`、`getCachedModels`、`getCachedModelConfig`、`withMaxContextAsDefault`、`isCacheStale`、`updateQoderModelsCache`。约 180 行,全为逻辑。

**不做 re-export。** `index.ts` 与 `models.test.ts` 直接从 `models-static.js` import,使消费者一眼区分拿到的是静态数据还是缓存逻辑。

静态表保留为 TypeScript 而非外移 JSON:这张表最易犯的错是字段名写错或类型不符,`QoderModelDef` 的类型约束正是防这个的。JSON 会丢掉该约束。

必须同步的两处测试:

- `models.test.ts:2` — `staticCnModels`、`staticModels`、`ZERO_COST` 改从 `../models-static.js` import。仅改 import 路径,断言一字不动。
- `oauth.test.ts:29-31` — `vi.mock("../models.js")` 中 mock 了 `staticModels: []` 与 `staticCnModels: []`,但 `oauth.ts` 只 import `updateQoderModelsCache`,这两行是历史遗留的空转 mock。删除后确认测试仍绿。

## 死代码清理

**`maxTokens` 的恒真分支。** 该逻辑在阶段一拆分后位于 `request.ts`(原在 `stream.ts`),故此步必须排在 `request.ts` 拆出之后。现状:

```ts
let maxTokens = 32768;
if (maxOutputTokens > 0) {
  maxTokens = maxOutputTokens;
}
```

上游 `const maxOutputTokens = modelConfig.max_output_tokens || 32768` 恒为正,故初值与判断俱死。改为:

```ts
let maxTokens = maxOutputTokens;
if (options?.maxTokens && options.maxTokens < maxTokens) maxTokens = options.maxTokens;
```

**`usage` 类型中的 `completion_tokens_details.reasoning_tokens`。** 声明后从不读取,删除该字段声明。删除类型字段不影响运行时行为。

## 测试策略

### 阶段一"行为零变化"的证明

主证据是现有 138 个测试全绿。它们覆盖 SSE 解析、tool call 组装、usage 映射、重试与 `Retry-After`、thinking 解析、message transform、COSY 签名、models 缓存。搬移改错逻辑会使它们失败。

因为"测试全绿"不足以排除语义漂移,追加两条纪律:

1. **搬移即搬移。** 函数迁入新文件后逐行对照原文,除 import 路径与 `export` 关键字外不改一个字符。要顺手做的改动(`splitSSEData` 的单趟扫描、`stableID` 的合并)必须单独成 commit,与纯搬移分离。
2. **一个文件一个 commit。** 出问题可二分定位到具体某次搬移。

### 新增测试

| 文件 | 覆盖内容 |
| --- | --- |
| `src/__tests__/sse.test.ts` | 跨 chunk 切断的行;一个 chunk 含多个 `data:`;非 `data:` 行(`event:`、注释行 `:`);`\r\n` 换行;空 `data:`;`rest` 正确保留不完整尾行;连续空行 |
| `src/__tests__/events.test.ts` | `mapUsage` 表驱动:`prompt_tokens` 含与不含 `cached_tokens`;有与无 `cache_write_tokens`;字段全缺;`cacheable_tokens` 必须被忽略(它是容量指标,非写入计数) |

这两块是本方案相对"仅按职责三分"多出的价值:当前 `mapUsage` 的语义只能通过跑一整条 SSE 流间接覆盖一个 case,行切分则完全无测试。

新增测试不改动被测行为,仍处于"行为零变化"范围内。

### 验证命令

```bash
npm run check      # tsc --noEmit
npm run lint       # biome check
npx vitest run
```

阶段一完成的判定标准:

1. 三条命令全绿
2. 138 个原有测试的断言**一字未改** —— 唯一允许的改动是 `models.test.ts` 的 import 路径,那不是断言
3. 新增 `sse.test.ts` 与 `events.test.ts` 通过

原有测试若需修改断言才能通过,说明拆分改变了行为,必须回退重做。

### 不做字节级对照

曾考虑固定 `crypto.randomUUID` 与 `Date.now` 后比较重构前后 `encodedBytes` 是否完全一致。不采用:为此要在生产代码中引入注入点,而注入点本身就是行为之外的改动,与"行为零变化"的目标冲突。改以 138 个测试加搬移纪律为保证。

## 实施顺序

每步一个 commit,每步结束时三条验证命令必须全绿。

1. `models-static.ts` 拆出 + 两处测试 import 同步(最独立,风险最低)
2. `sse.ts` 拆出 + `sse.test.ts`(纯函数,零依赖)
3. `transport.ts` 拆出(纯搬移)
4. `events.ts` 拆出 + `events.test.ts` 中的 `mapUsage` 测试
5. `request.ts` 拆出
6. `oauth.ts` 新增 `resolveQoderIdentity`,4 处调用点收敛
7. `stableID` 合并 + `splitSSEData` 单趟扫描优化(两处"顺手改动",与搬移分离)
8. 死代码清理

## 阶段二方向记录

阶段一完成后另出设计。此处仅记录方向与已知风险,不构成实施依据。

| # | 问题 | 方向 | 风险 |
| --- | --- | --- | --- |
| 1 | `getCachedCredentials(_accessToken, …)` 忽略首参;COSY 签名的 `uid` 取自 `auth.json`,而 `authToken` 取自 `options.apiKey`,换账号时二者可能来自不同账号 | 令 `resolveQoderIdentity` 校验 token 归属,不匹配时拒绝签名或强制 re-exchange | 中 —— 需先确定 pi 在何种时序下会传入与 `auth.json` 不一致的 apiKey |
| 2 | 扩展加载 `await` 3 次串行网络请求(PAT exchange → userinfo → model list) | 改为惰性:注册时用缓存或静态表,首次真正需要时再抓取;或令 `--list-models` 走同步路径而交互式启动走后台 | 中 —— 需先确认 `--list-models` 的实际时序约束 |
| 3 | `QODER_MODE=cn` 时 `qoder` 与 `qoder-cn` 注册为内容完全相同的两个 provider | README 记载 `qoder` 跟随 region 属有意设计,不能简单去除。倾向:检测到两条等价时只注册 `qoder-cn` 并打一行提示 | 低 |
| 4 | `Accept-Encoding: identity` 放弃压缩,而 base64 请求体可压至约三分之一 | 先做实验:带 `gzip` 发一次真实请求,观察 WAF 是否拒绝。拒绝则补注释说明原因,否则开启压缩 | 低 —— 实验先行,不作猜测 |

第 2、3 项依赖 pi 侧的时序与注册语义,实施前需阅读 `pi-coding-agent` 的 `registerProvider` 与 `--list-models` 实现,而非推测。

## 已定决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 改动去向 | 本地自用,不回上游 | 用户确认;因此不受 diff 大小与文件布局兼容性约束 |
| 拆分刻度 | 按职责三分 + `sse.ts` 与 `mapUsage` 纯函数化 | 后两者把已知易错且当前不可单独测试的逻辑变为可测,非预留扩展点 |
| 阶段划分 | 纯重构与行为变更分离 | 重构的正确性证明依赖行为不变这一前提 |
| 未来方向预留 | 不预留 | 用户确认无特定方向;按职责边界切分即可 |
| `push()` 返回类型 | `"continue" \| "done"` | 调用点 `=== "done"` 自解释,无需回查签名 |
| 静态表形态 | 保留 TypeScript | 保住 `QoderModelDef` 类型约束,该表最易错处正在字段与类型 |
| 字节级对照 | 不做 | 需引入 UUID/时间戳注入点,与行为零变化目标冲突 |
