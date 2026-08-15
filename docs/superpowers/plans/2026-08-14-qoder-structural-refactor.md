# Qoder Provider 结构性重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 880 行的 `src/stream.ts` 拆成编排层加四个单职责模块,把 380 行静态模型数据从 `src/models.ts` 移出,并消除 4 处重复的身份 fallback 逻辑 —— 全程行为零变化。

**Architecture:** 阶段一是纯重构。`stream.ts` 只留编排(解析身份 → 造请求 → 开流 → 喂状态机);`transport.ts` 管重试与超时且不引用任何 pi 类型;`events.ts` 管 SSE 语义到 pi 事件的翻译且不引用 `fetch`;`sse.ts` 是零依赖纯函数;`request.ts` 管请求体构造。现有 138 个测试是回归网,搬移改错逻辑它们会失败。

**Tech Stack:** TypeScript 5.7(strict)、Node 20 baseline、vitest 4、biome 2.4、esbuild 打包为 ESM。

设计依据:`docs/superpowers/specs/2026-08-14-qoder-structural-refactor-design.md`

## 实施后偏差(2026-08-14 完成时补记)

这份 plan 与 spec 是实施**前**写的,下面的记述在实施中被证明不准确或被有意改掉。原文一律保留 ——
计划与结果的差异本身是信息。**判断接口时以源码为准,不以本文档为准。**

| 本文档写的 | 实际结果 | 原因 |
|---|---|---|
| `QoderModelEntry` 移入 `models-static.ts`(`:43,56,68,82`,spec `:68,357`) | 留在 `models.ts:15`,module-private | Task 1 的 review 指出它只被 `models.ts` 用,人类裁定 review 正确。**但那个"唯一消费者"前提后来也被证伪**:whole-branch review 发现它有两个 —— 导出函数 `getCachedModelConfig` 的返回类型,以及 `request.ts:66-75` 手工构造的同形对象;tsc 已验证两者未被类型耦合 |
| Task 6 的解析函数返回 `QoderIdentity`(`:889-890`) | 返回 `QoderUserIdentity = Omit<QoderIdentity, "machineID">`,并多一个导出 `resolveQoderSigningIdentity` | `index.ts` 的两个消费者只要三字段,让解析函数无条件解析机器身份是类型不诚实;`qoderIdentityDefaults` 本就返回 `Omit<...>`,这只是把该区分贯彻下去 |
| Task 7 导出 `chatRecordParts` generator | 导出 `chatRecordID` | 让测试调用生产实际调用的函数;generator 形状抓不到调用点用错 domain prefix 的错误 |
| Task 8 的 `if (maxOutputTokens > 0)` 是死分支 | **它是活的**,误删后已恢复(`826cada`) | `\|\| 32768` 只筛 falsy,负数是 truthy;`modelConfig` 来自磁盘 cache 里逐字持久化的服务端 entry。两个独立 reviewer 分别命中 |
| 行数表(`:1394-1402`) | cosy 328 / oauth 287 / models 218 / request 172 / stream 131 / sse 46 | — |
| `stream.ts` 超 120 行说明有该搬的没搬(`:1403`) | 131 行,已裁定接受 | 里面已无死代码,再压 11 行等于为数字搬运编排代码 |
| 测试 177(`:1460`) | **276** | 计划只算了差分测试。实际另加:跨 chunk 与 UTF-8 边界(补上一个 HIGH 级缺口 —— 全套此前从未分块交付过响应体)、请求体 key 集合与顺序、`max_output_tokens` 钳制、machine-id 回落运算符、单次 auth 读取、SSE 游标推进 |

行为零变化这条约束守住了,唯一的例外是上表第四行 —— 它被 review 抓到并恢复。


## Global Constraints

以下约束适用于每个 Task,不再逐条重复:

- **行为零变化。** 阶段一不得改变任何运行时行为。唯一例外是 Task 7 的两处显式优化(`stableID` 合并、`splitSSEData` 单趟扫描),它们各自附带差分测试证明输出不变。
- **138 个原有测试的断言一字不改。** 唯一允许的改动是 `src/__tests__/models.test.ts:2` 的 import 路径与 `src/__tests__/oauth.test.ts:29-31` 的空转 mock 删除。原有测试若需修改断言才能通过,说明拆分改变了行为,必须回退重做。
- **搬移即搬移。** 函数迁入新文件后逐行对照原文,除 import 路径与 `export` 关键字外不改一个字符。不得顺手重命名、不得顺手调整格式、不得顺手改注释。
- **一个 Task 一个 commit。** 出问题可二分定位到具体某次搬移。
- **每个 Task 结束前三条命令必须全绿:** `npm run check`、`npm run lint`、`npx vitest run`。
- **Node 20 baseline。** 不得使用 `Promise.withResolvers`(需 ES2024/Node 22)等更高版本 API。`src/stream.ts:175-188` 的 `sleep` 用 executor 形式正是为此。
- **Commit message 不含单号**(用户明确指示),不含 `Co-authored-by:` 或 `Signed-off-by:` 等归属 trailer(仓库规则)。风格跟随仓库:英文 conventional commit。
- **不改 `transform.ts`、`thinking-parser.ts`、`login.ts`、`usage.ts`、`qoder-encoding.ts`。** Task 6 会改两个文件:`cosy.ts` 新增 `QoderIdentity` 与 `qoderIdentityDefaults`(放这里是为避免 `oauth → pat → oauth` 循环依赖,理由见 Task 6 Step 4),`pat.ts` 改两行以复用该默认值。除此之外这五个文件一行不动。
- **行号会随每个 Task 变化。** 本计划中的行号来自重构开始前的状态(`stream.ts` 881 行、`models.ts` 562 行)。执行某个 Task 前先 `read` 目标文件确认当前行号,不要盲信本文行号。

---

### Task 1: 拆出 `models-static.ts`

最独立、风险最低,先做以建立节奏。

**Files:**
- Create: `src/models-static.ts`
- Modify: `src/models.ts:1-12`(imports)、`src/models.ts:13-41`(类型与 ZERO_COST 移出)、`src/models.ts:53-378`(静态表移出)
- Modify: `src/index.ts:10`(import 来源)
- Test: `src/__tests__/models.test.ts:2`(仅改 import 路径)、`src/__tests__/oauth.test.ts:29-31`(删空转 mock)

**Interfaces:**
- Consumes: 无(第一个 Task)
- Produces:
  - `export const ZERO_COST: Readonly<{ input: 0; output: 0; cacheRead: 0; cacheWrite: 0 }>`
  - `export interface QoderModelEntry`(字段与现 `models.ts:16-28` 完全一致)
  - `export interface QoderModelDef`(字段与现 `models.ts:30-41` 完全一致)
  - `export const staticModels: QoderModelDef[]`(15 条)
  - `export const staticCnModels: QoderModelDef[]`(9 条)

- [ ] **Step 1: 读取要搬移的内容,确认边界**

Run: `read src/models.ts:1-55` 与 `read src/models.ts:370-380`

确认三件事:`ZERO_COST` 在第 13 行;`staticModels` 从第 53 行开始;`staticCnModels` 在第 378 行前结束(其后紧接 `getCachedModels`)。若行号与此不符,以实际为准并记录。

- [ ] **Step 2: 创建 `src/models-static.ts`**

文件头如下,其后原样粘贴 `models.ts` 的 `ZERO_COST`、`QoderModelEntry`、`QoderModelDef`、`staticModels`、`staticCnModels`:

```ts
import { getQoderBaseUrl } from "./cosy.js";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
```

只需 `getQoderBaseUrl` 一个 import —— `staticCnModels` 的每条 `baseUrl: getQoderBaseUrl("cn")` 用到它,`staticModels` 用的是硬编码字面量 `"https://api3.qoder.sh/"`。**不要**顺手把字面量改成函数调用,那是行为之外的改动。

- [ ] **Step 3: 从 `models.ts` 删除已搬移的内容并改 import**

删除 `ZERO_COST`、`QoderModelEntry`、`QoderModelDef`、`staticModels`、`staticCnModels` 五个声明。`models.ts` 顶部 import 改为:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildAuthHeaders,
  getQoderBaseUrl,
  getQoderCNFriendlyModelInfo,
  getQoderMode,
  getQoderModelListURL,
  isQoderCNMode,
} from "./cosy.js";
import { ZERO_COST, type QoderModelDef, type QoderModelEntry } from "./models-static.js";
```

注意 `models.ts` 保留的 `getCachedModels` 仍需 `staticModels`/`staticCnModels` 作为 fallback 返回值(现 `models.ts:395`),所以也要 import 这两个值:

```ts
import { staticCnModels, staticModels, ZERO_COST, type QoderModelDef, type QoderModelEntry } from "./models-static.js";
```

**不做 re-export。** `models.ts` 不得写 `export { staticModels }`,否则消费者无法从 import 语句看出拿的是数据还是逻辑。

- [ ] **Step 4: 更新 `index.ts` 的 import**

`src/index.ts:10` 现为:

```ts
import { getCachedModels, isCacheStale, staticCnModels, staticModels, updateQoderModelsCache } from "./models.js";
```

改为两行:

```ts
import { getCachedModels, isCacheStale, updateQoderModelsCache } from "./models.js";
import { staticCnModels, staticModels } from "./models-static.js";
```

- [ ] **Step 5: 更新两处测试 import**

`src/__tests__/models.test.ts:2`:

```ts
import { staticCnModels, staticModels, ZERO_COST } from "../models-static.js";
```

`src/__tests__/oauth.test.ts:29-31` 删除两行空转 mock。改动前后对照 —— 现状:

```ts
vi.mock("../models.js", () => ({
  updateQoderModelsCache: vi.fn().mockResolvedValue(undefined),
  isCacheStale: vi.fn().mockReturnValue(true),
  staticModels: [],
  staticCnModels: [],
}));
```

改为:

```ts
vi.mock("../models.js", () => ({
  updateQoderModelsCache: vi.fn().mockResolvedValue(undefined),
  isCacheStale: vi.fn().mockReturnValue(true),
}));
```

删除理由:`oauth.ts` 只从 `models.js` import `updateQoderModelsCache`,这两行 mock 从未被读取。

- [ ] **Step 6: 验证**

```bash
npm run check && npm run lint && npx vitest run
```

Expected: tsc 无输出、biome 报 `Checked 24 files`(比之前多一个)、`Tests 138 passed`。

若 `models.test.ts` 的断言失败,说明搬移时改动了数据 —— 回退重做,不要改断言。

- [ ] **Step 7: Commit**

```bash
git add src/models-static.ts src/models.ts src/index.ts src/__tests__/models.test.ts src/__tests__/oauth.test.ts
git commit -m "refactor: move the static model catalogue out of models.ts

380 of models.ts's 562 lines were catalogue data sitting on top of the cache
logic. models-static.ts now holds the data and the two shared types; models.ts
keeps only behaviour. No re-export: consumers import from whichever file they
actually depend on.

Also drops two dead mock entries in oauth.test.ts - oauth.ts only imports
updateQoderModelsCache from models.js, so the staticModels/staticCnModels mocks
were never read."
```

---

### Task 2: 拆出 `sse.ts` 并补测试

`sse.ts` 是零依赖纯函数,也是全仓库唯一可以先写测试再写实现的部分 —— 现有代码里这段逻辑内联在 `stream.ts:579-592`,一个测试都没有。

**Files:**
- Create: `src/sse.ts`
- Create: `src/__tests__/sse.test.ts`
- Modify: 无(本 Task 只新增;接入 `stream.ts` 在 Task 4 完成)

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface SSESplit { payloads: string[]; rest: string }`
  - `export function splitSSEData(buffer: string): SSESplit`

- [ ] **Step 1: 写失败测试**

创建 `src/__tests__/sse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitSSEData } from "../sse.js";

describe("splitSSEData", () => {
  it("returns the payload of a single complete data line", () => {
    const { payloads, rest } = splitSSEData("data:hello\n");
    expect(payloads).toEqual(["hello"]);
    expect(rest).toBe("");
  });

  it("keeps an incomplete trailing line in rest", () => {
    const { payloads, rest } = splitSSEData("data:first\ndata:seco");
    expect(payloads).toEqual(["first"]);
    expect(rest).toBe("data:seco");
  });

  it("returns every data line in one chunk, in order", () => {
    const { payloads } = splitSSEData("data:a\n\ndata:b\n\ndata:c\n");
    expect(payloads).toEqual(["a", "b", "c"]);
  });

  it("drops lines that are not data fields", () => {
    // `event:` and comment lines (`:`) are valid SSE the provider does not use.
    const { payloads } = splitSSEData("event:message\n:heartbeat\ndata:kept\n");
    expect(payloads).toEqual(["kept"]);
  });

  it("tolerates CRLF line endings", () => {
    // trim() removes the \r, so the payload must come through clean.
    const { payloads, rest } = splitSSEData("data:crlf\r\n");
    expect(payloads).toEqual(["crlf"]);
    expect(rest).toBe("");
  });

  it("yields an empty payload for a bare data field", () => {
    const { payloads } = splitSSEData("data:\n");
    expect(payloads).toEqual([""]);
  });

  it("ignores blank lines", () => {
    const { payloads, rest } = splitSSEData("\n\n\n");
    expect(payloads).toEqual([]);
    expect(rest).toBe("");
  });

  it("returns the whole buffer as rest when there is no line break yet", () => {
    const { payloads, rest } = splitSSEData("data:partial");
    expect(payloads).toEqual([]);
    expect(rest).toBe("data:partial");
  });

  it("strips whitespace around the payload", () => {
    const { payloads } = splitSSEData("data:   spaced   \n");
    expect(payloads).toEqual(["spaced"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/sse.test.ts`
Expected: FAIL,报 `Failed to resolve import "../sse.js"`。

- [ ] **Step 3: 写实现**

创建 `src/sse.ts`。**本 Task 原样保留现有 `stream.ts:579-592` 的 `substring` 语义**,单趟扫描优化留到 Task 7 —— 搬移与改写分开提交才能二分定位。

```ts
/** One pass of SSE framing: the `data:` payloads found, plus what is left over. */
export interface SSESplit {
  /** `data:` payload values, already trimmed, in arrival order. */
  payloads: string[];
  /** Unconsumed tail: an incomplete final line, kept for the next chunk. */
  rest: string;
}

/**
 * Split a decoded chunk buffer into SSE `data:` payloads.
 *
 * Framing only — this function knows nothing about Qoder. Lines that are not
 * `data:` fields (`event:`, comments, blanks) are dropped, and a final line
 * with no terminating newline is returned in `rest` so the caller can prepend
 * the next chunk to it.
 */
export function splitSSEData(buffer: string): SSESplit {
  const payloads: string[] = [];
  let rest = buffer;
  while (true) {
    const lineEnd = rest.indexOf("\n");
    if (lineEnd === -1) break;
    const line = rest.substring(0, lineEnd).trim();
    rest = rest.substring(lineEnd + 1);
    if (!line.startsWith("data:")) continue;
    payloads.push(line.substring(5).trim());
  }
  return { payloads, rest };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/sse.test.ts`
Expected: `Tests 9 passed`。

若 `tolerates CRLF` 失败,检查是否漏了 `.trim()` —— `\r` 靠它清除,这与现有 `stream.ts:582` 的行为一致。

- [ ] **Step 5: 全量验证**

```bash
npm run check && npm run lint && npx vitest run
```

Expected: `Tests 147 passed`(138 + 9)。

- [ ] **Step 6: Commit**

```bash
git add src/sse.ts src/__tests__/sse.test.ts
git commit -m "refactor: extract SSE line framing into a pure function

The framing was inlined in the read loop with no test of its own: CRLF, bare
data fields, event/comment lines, and payloads split across chunks were all
unverified. splitSSEData keeps the existing substring semantics exactly - the
single-pass rewrite is a separate commit so a regression can be bisected to
one or the other.

Not wired into stream.ts yet; that happens when events.ts lands."
```

---

### Task 3: 拆出 `transport.ts`

纯搬移,不改一个字符的逻辑。

**Files:**
- Create: `src/transport.ts`
- Modify: `src/stream.ts:1-27`(imports)、删除 `src/stream.ts:38-78` 与 `src/stream.ts:103-335`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface OpenStreamRequest { chatURL: string; encodedBytes: Buffer<ArrayBuffer>; qoderModel: string; modelSource: string; callerSignal?: AbortSignal; creds: { userID: string; authToken: string; name: string; email: string; machineID: string } }`
  - `export interface OpenedQoderStream { reader: ReadableStreamDefaultReader<Uint8Array>; firstChunk: Uint8Array; armIdleWatchdog: () => void; disarmWatchdog: () => void; describeStreamError: (error: unknown) => Error }`
  - `export function openQoderStream(request: OpenStreamRequest): Promise<OpenedQoderStream>`

- [ ] **Step 1: 确认搬移边界**

Run: `read src/stream.ts`(无 selector,得到结构摘要)

要搬移的 13 个声明及其源行号:

| 声明 | 行号 |
| --- | --- |
| Transport budget 常量块(含注释) | 38-47 |
| `RETRYABLE_ERROR_CODES` | 49-67 |
| `RETRYABLE_STATUSES` | 69-78 |
| `parseRetryAfterMs` | 103-116 |
| `RETRYABLE_ERROR_MESSAGES` | 118-124 |
| `ErrorLink` | 126-130 |
| `errorChain` | 132-148 |
| `isRetryableTransportError` | 150-157 |
| `formatTransportError` | 159-173 |
| `sleep` | 175-188 |
| `OpenStreamRequest` | 190-197 |
| `OpenedQoderStream` | 199-207 |
| `openQoderStream` | 209-335 |

**80-101 不搬** —— 那是 `FINISH_REASON_TO_STOP_REASON`,属于 Task 4 的 `events.ts`。它夹在 `RETRYABLE_STATUSES` 与 `parseRetryAfterMs` 之间,搬移时不要连带。

- [ ] **Step 2: 创建 `src/transport.ts`**

文件头:

```ts
import { buildAuthHeaders } from "./cosy.js";
```

其后按上表顺序原样粘贴 13 个声明。三处需要加 `export`:`OpenStreamRequest`、`OpenedQoderStream`、`openQoderStream`。其余 10 个保持模块私有(不加 `export`)。

**这个文件不得引用任何 `@earendil-works/pi-ai` 或 `@earendil-works/pi-coding-agent` 的类型。** 检查方式:文件里不应出现 `AssistantMessage`、`Model`、`Context`、`SimpleStreamOptions` 等名字。这条边界是本次拆分的目的之一 —— 重试策略应当能脱离 pi 的类型体系推理。

- [ ] **Step 3: 从 `stream.ts` 删除搬移出去的内容**

删除 38-78 与 103-335(共两段,保留 80-101)。`stream.ts` 顶部加 import:

```ts
import { openQoderStream, type OpenedQoderStream } from "./transport.js";
```

同时清理 `stream.ts` 中因搬移而不再使用的 import。`buildAuthHeaders` 现在只被 `transport.ts` 用,须从 `stream.ts` 的 `./cosy.js` import 列表中删除。`getQoderChatURL`、`getMachineId`、`getQoderCNDirectModel`、`getQoderMode`、`getQoderUserEmailFallback`、`isQoderCNMode` 仍在 `stream.ts` 使用,保留。

- [ ] **Step 4: 验证**

```bash
npm run check && npm run lint && npx vitest run
```

Expected: `Tests 147 passed`。

`npm run check` 会抓出遗漏的 import 与未使用的 import(strict 模式下未使用的 import 不报错,但 biome 会报 `noUnusedImports`)。两条都必须绿。

- [ ] **Step 5: Commit**

```bash
git add src/transport.ts src/stream.ts
git commit -m "refactor: move the transport layer into transport.ts

Retry policy, watchdogs, the error cause chain, Retry-After parsing, and
openQoderStream itself. Moved verbatim - no logic changed.

transport.ts references no pi types: it takes a Buffer and credentials and
returns a reader. Changing the retry policy no longer means reading the SSE
parser."
```

---

### Task 4: 拆出 `events.ts` 并接入 `sse.ts`

本 Task 最大。它不是纯行搬移 —— SSE 循环的内层要重构成类方法,循环外层留在 `stream.ts`。

**Files:**
- Create: `src/events.ts`
- Create: `src/__tests__/events.test.ts`
- Modify: `src/stream.ts` — 删除 29-36(`ToolCallState`)、80-101(`FINISH_REASON_TO_STOP_REASON`)、545-556 的状态声明、560-845 的循环与 finalize;换成新的编排循环

**Interfaces:**
- Consumes:
  - `splitSSEData(buffer: string): SSESplit`(Task 2)
- Produces:
  - `export interface QoderUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cacheable_tokens?: number; cached_tokens?: number; cache_write_tokens?: number } }`
  - `export function mapUsage(raw: QoderUsage): Pick<AssistantMessage["usage"], "input" | "output" | "totalTokens" | "cacheRead" | "cacheWrite">`
  - `export class QoderEventTranslator`,构造签名 `(output: AssistantMessage, stream: AssistantMessageEventStream, options: { thinkingEnabled: boolean })`,方法 `push(payload: string): "continue" | "done"` 与 `finalize(): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">`

- [ ] **Step 1: 先写 `mapUsage` 的失败测试**

`mapUsage` 是本 Task 唯一可以先测后写的部分 —— 它是纯函数,而现状只能靠跑一整条 SSE 流间接覆盖一个 case。

创建 `src/__tests__/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapUsage } from "../events.js";

describe("mapUsage", () => {
  it("subtracts cached and written tokens from prompt_tokens", () => {
    // pi-core computes promptTokens = input + cacheRead + cacheWrite, so `input`
    // must EXCLUDE both. Qoder follows OpenAI semantics where prompt_tokens
    // INCLUDES cached_tokens.
    expect(
      mapUsage({
        prompt_tokens: 42,
        completion_tokens: 7,
        total_tokens: 49,
        prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 10 },
      }),
    ).toEqual({ input: 27, output: 7, totalTokens: 49, cacheRead: 5, cacheWrite: 10 });
  });

  it("ignores cacheable_tokens, which is a capacity metric not a write count", () => {
    // cacheable_tokens is 0 even on a first-turn write, so mapping it to
    // cacheWrite would report writes that never happened.
    expect(
      mapUsage({
        prompt_tokens: 100,
        prompt_tokens_details: { cacheable_tokens: 99, cached_tokens: 0 },
      }),
    ).toEqual({ input: 100, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("treats a missing prompt_tokens_details as no cache activity", () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })).toEqual({
      input: 10,
      output: 3,
      totalTokens: 13,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("defaults every absent field to zero", () => {
    expect(mapUsage({})).toEqual({ input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("never reports negative input when the cache counts exceed prompt_tokens", () => {
    // Defensive: an inconsistent upstream must not produce a negative token
    // count, which pi would render as garbage.
    expect(
      mapUsage({ prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 10 } }).input,
    ).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/events.test.ts`
Expected: FAIL,`Failed to resolve import "../events.js"`。

- [ ] **Step 3: 创建 `src/events.ts` 的头部与 `mapUsage`**

```ts
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { stripThinkingTags, ThinkingTagParser } from "./thinking-parser.js";

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart?: boolean;
  emittedEnd?: boolean;
  contentIndex: number;
}

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

/**
 * OpenAI `usage` → pi's usage fields.
 *
 * pi-core computes `promptTokens = input + cacheRead + cacheWrite` (Anthropic
 * convention: `input` EXCLUDES cached/written tokens). Qoder follows OpenAI
 * semantics where `prompt_tokens` INCLUDES `cached_tokens`, so both cache
 * counts are subtracted to match the contract pi-ai's own OpenAI provider uses.
 * `cacheable_tokens` is a capacity metric, not a write count (it is 0 even on
 * first-turn writes), so it is NOT mapped to cacheWrite.
 */
export function mapUsage(
  raw: QoderUsage,
): Pick<AssistantMessage["usage"], "input" | "output" | "totalTokens" | "cacheRead" | "cacheWrite"> {
  const promptTokens = raw.prompt_tokens ?? 0;
  const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    input: Math.max(0, promptTokens - cacheRead - cacheWrite),
    output: raw.completion_tokens ?? 0,
    totalTokens: raw.total_tokens ?? 0,
    cacheRead,
    cacheWrite,
  };
}
```

`ToolCallState` 是从 `stream.ts:29-36` 原样搬来的,保持模块私有。

注意 `QoderUsage` 相比 `stream.ts:615-625` 的内联类型**删掉了 `completion_tokens_details`** —— 那个字段声明后从未被读取。删除类型字段不影响运行时行为(Task 8 的死代码清理提前在此完成,因为搬移时保留一个明知无用的字段更糟)。

- [ ] **Step 4: 跑 `mapUsage` 测试确认通过**

Run: `npx vitest run src/__tests__/events.test.ts`
Expected: `Tests 5 passed`。

- [ ] **Step 5: 把 `FINISH_REASON_TO_STOP_REASON` 搬入 `events.ts`**

从 `stream.ts:80-101` 原样搬移(含全部注释),置于 `mapUsage` 之前,保持模块私有:

```ts
const FINISH_REASON_TO_STOP_REASON: Record<string, "stop" | "length" | "toolUse"> = {
  stop: "stop",
  end_turn: "stop",
  length: "length",
  max_tokens: "length",
  tool_calls: "toolUse",
  function_call: "toolUse",
  content_filter: "stop",
};
```

原文的 8 行块注释必须一起搬 —— 它解释了为什么不能用 `as` 强转,那是 `ad1b547` 修掉的 bug 的根因记录。

- [ ] **Step 6: 写 `QoderEventTranslator` 类**

类骨架如下。每个方法体的来源行号已标注,**方法体逐行搬移原文,只把 `output`/`stream` 换成 `this.output`/`this.stream`,把局部变量换成 `this.` 字段**:

```ts
export class QoderEventTranslator {
  private contentBlockIndex = -1;
  private thinkingBlockIndex = -1;
  private readonly toolCallsState: ToolCallState[] = [];
  private readonly thinkingParser: ThinkingTagParser | null;

  constructor(
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream,
    options: { thinkingEnabled: boolean },
  ) {
    this.thinkingParser = options.thinkingEnabled ? new ThinkingTagParser(output, stream) : null;
  }

  /**
   * Feed one SSE `data:` payload.
   *
   * Returns "done" when the terminator arrived, "continue" otherwise. A
   * malformed line is skipped (logged under QODER_DEBUG) because one bad line
   * must not kill the stream; an upstream error envelope throws, because that
   * one must reach the caller as stopReason "error".
   */
  push(payload: string): "continue" | "done" {
    // from stream.ts:589-592
    if (payload === "[DONE]") return "done";

    try {
      // from stream.ts:595-609
      const envelope = JSON.parse(payload);
      if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
        throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
      }
      const innerStr = envelope.body;
      if (innerStr === "[DONE]") return "done";
      if (!innerStr) return "continue";

      // from stream.ts:611-642
      const inner = JSON.parse(innerStr);
      if (inner.id) this.output.responseId = inner.id as string;
      if (inner.model) this.output.responseModel = inner.model as string;
      if (inner.usage) Object.assign(this.output.usage, mapUsage(inner.usage as QoderUsage));

      // from stream.ts:643-793
      if (inner.choices && inner.choices.length > 0) {
        const choice = inner.choices[0];
        if (choice.delta) this.handleDelta(choice.delta);
        if (choice.finish_reason) this.handleFinishReason(String(choice.finish_reason));
      }
      return "continue";
    } catch (e) {
      // from stream.ts:794-805
      if (e instanceof SyntaxError) {
        if (process.env.QODER_DEBUG) {
          console.error("[pi-provider-qoder] skipping malformed SSE line:", payload.slice(0, 200));
        }
        return "continue";
      }
      throw e;
    }
  }

  /** from stream.ts:647-776 — reasoning_content, content, tool_calls */
  private handleDelta(delta: Record<string, unknown>): void {
    /* 逐行搬移 stream.ts:648-775 的三个分支 */
  }

  /** from stream.ts:778-792 */
  private handleFinishReason(upstream: string): void {
    /* 逐行搬移 */
  }

  /**
   * Close open blocks, finalise tool calls, and decide the stop reason.
   * Throws when upstream promised tool_calls and sent none.
   */
  finalize(): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
    /* 搬移 stream.ts:810-859,末尾 return this.output.stopReason as ... */
  }
}
```

三处需要注意的搬移细节:

1. **`Object.assign(this.output.usage, mapUsage(...))`** 取代原来的 5 行逐字段赋值。等价:原代码写的正是 `input`/`output`/`totalTokens`/`cacheRead`/`cacheWrite` 这五个字段,`cost` 不在其中,`Object.assign` 只覆盖 `mapUsage` 返回的那五个键。
2. **`push` 中的裸 `[DONE]` 判断**必须在 `try` 之前 —— 原代码 `stream.ts:589` 也在 `try`(第 594 行)之前。若挪进 `try`,行为不变但偏离了"逐行搬移"纪律。
3. **`finalize()` 末尾的 `return`** 是新增的一行(原代码把 reason 直接用在第 864 行的 `stream.push`)。原第 862-866 行的 `stream.push({ type: "done", ... })` **不搬进 `finalize`** —— 它留在 `stream.ts`,因为 `error` 路径的终止事件也在那里,发射终止事件的职责必须集中在编排层。

- [ ] **Step 7: 重写 `stream.ts` 的编排循环**

删除 `stream.ts:545-556` 的状态声明与 `560-845` 的循环加 finalize,换成:

```ts
      const decoder = new TextDecoder();
      const thinkingEnabled = (options?.reasoning as unknown) !== false && (options?.reasoning as unknown) !== "off";
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

`stream.ts` 顶部 import 增加:

```ts
import { QoderEventTranslator } from "./events.js";
import { splitSSEData } from "./sse.js";
```

同时删除 `stream.ts` 中不再使用的 import:`TextContent`、`ThinkingContent`、`ToolCall`、`stripThinkingTags`、`ThinkingTagParser` 现在都只被 `events.ts` 使用。`AssistantMessage` 仍需保留(第 385 行的 `output` 声明)。

- [ ] **Step 8: 验证**

```bash
npm run check && npm run lint && npx vitest run
```

Expected: `Tests 152 passed`(147 + 5)。

`stream.test.ts` 的 24 个测试全部覆盖本次搬移的逻辑 —— 它们绿了才说明状态机搬对了。若 `keeps tool call arguments intact when a <thinking> tag leaks into content` 失败,检查 `contentBlockIndex`/`thinkingBlockIndex` 是否正确变成了实例字段而非在方法里重新声明为局部变量。

- [ ] **Step 9: Commit**

```bash
git add src/events.ts src/__tests__/events.test.ts src/stream.ts
git commit -m "refactor: move SSE-to-pi-event translation into events.ts

The read loop's 280-line body becomes QoderEventTranslator: push() takes one
SSE data payload, finalize() closes the blocks and returns the stop reason.
stream.ts keeps only the loop, because the terminal done/error events have to
be emitted from one place - the error path lives in its catch.

mapUsage is now a real function with its own tests. Its Anthropic-vs-OpenAI
token semantics were previously reachable only by running a whole SSE stream,
which covered exactly one case.

events.ts references no fetch, so SSE semantics can be tested without a
network. Also drops the never-read completion_tokens_details type field."
```

---

### Task 5: 拆出 `request.ts`

**Files:**
- Create: `src/request.ts`
- Modify: `src/stream.ts` — 删除 337-374(两个 hash 函数)与 425-532(请求体构造);换成一次 `buildChatRequest` 调用

**Interfaces:**
- Consumes: 无(与 Task 3、4 无耦合)
- Produces:
  - `export interface QoderChatRequest { encodedBytes: Buffer<ArrayBuffer>; qoderModel: string; modelSource: string; chatURL: string }`
  - `export function buildChatRequest(args: { model: Model<Api>; context: Context; options: SimpleStreamOptions | undefined; providerMode: string; identity: { userID: string; name: string; email: string; machineID: string } }): QoderChatRequest`

`identity` 此处用结构化字面量而非 `QoderIdentity` 类型 —— `QoderIdentity` 由 Task 6 引入。Task 6 会把这里改为引用该类型。

- [ ] **Step 1: 创建 `src/request.ts`**

文件头:

```ts
import crypto from "node:crypto";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getQoderChatURL, getQoderCNDirectModel, isQoderCNMode } from "./cosy.js";
import { getCachedModelConfig } from "./models.js";
import { qoderEncodeBodyToBuffer } from "./qoder-encoding.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";
```

其后原样搬入 `stream.ts:337-345`(`stableHash`)与 `347-374`(`stableChatRecordID`),两者保持模块私有。**本 Task 不合并它们** —— 合并是 Task 7,附带差分测试。

- [ ] **Step 2: 写 `buildChatRequest`**

函数体是 `stream.ts:425-532` 的逐行搬移。签名与返回:

```ts
export interface QoderChatRequest {
  encodedBytes: Buffer<ArrayBuffer>;
  qoderModel: string;
  modelSource: string;
  chatURL: string;
}

/**
 * Build the chat request body and everything the transport needs to send it.
 *
 * Pure with respect to the network: it reads the model cache and hashes the
 * conversation, but performs no I/O beyond that cache read.
 */
export function buildChatRequest(args: {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  providerMode: string;
  identity: { userID: string; name: string; email: string; machineID: string };
}): QoderChatRequest {
  const { model, context, options, providerMode, identity } = args;
  /* 逐行搬移 stream.ts:425-532 */
  return { encodedBytes, qoderModel, modelSource, chatURL };
}
```

搬移时的名字替换,共四处:

| 原文(`stream.ts`) | 搬移后 |
| --- | --- |
| `userID`(第 461 行 `stableHash` 调用) | `identity.userID` |
| `model.id` | 不变(`model` 是入参) |
| `options?.maxTokens`、`options?.sessionId`、`options?.signal` | 不变 |
| `providerMode` | 不变(入参) |

`stream.ts:528-529` 的 `bodyBytes`/`encodedBytes` 与 `531-532` 的 `chatURL`/`modelSource` 都搬进来,作为返回值的四个字段。

- [ ] **Step 3: 改 `stream.ts` 调用点**

删除 337-374 与 425-532,换成:

```ts
      const request = buildChatRequest({ model, context, options, providerMode, identity });

      opened = await openQoderStream({
        ...request,
        callerSignal: options?.signal,
        creds: { ...identity, authToken: accessToken },
      });
```

`...request` 展开后正好提供 `OpenStreamRequest` 需要的 `chatURL`、`encodedBytes`、`qoderModel`、`modelSource` 四个字段。

本 Task 中 `identity` 仍由原地的四行 fallback 产生(`stream.ts:419-423`),只是把结果收进一个对象:

```ts
      const cachedCreds = getCachedCredentials(accessToken, model.provider);
      const identity = {
        userID: cachedCreds?.userID || "qoder-user",
        name: cachedCreds?.name || (isQoderCNMode(providerMode) ? "Qoder CN User" : "Qoder User"),
        email: cachedCreds?.email || getQoderUserEmailFallback(providerMode),
        machineID: cachedCreds?.machineID || getMachineId(),
      };
```

Task 6 会把这一段换成 `resolveQoderIdentity` 调用。此处先保持逻辑不变,只改形状。

`stream.ts` 顶部 import 增加 `import { buildChatRequest } from "./request.js";`,删除现在只被 `request.ts` 使用的:`getQoderChatURL`、`getQoderCNDirectModel`、`getCachedModelConfig`、`qoderEncodeBodyToBuffer`、`transformMessagesForQoder`、`transformTools`,以及不再需要的 `crypto`(确认 `stream.ts` 中已无 `crypto.` 调用后再删)。

- [ ] **Step 4: 验证**

```bash
npm run check && npm run lint && npx vitest run
```

Expected: `Tests 152 passed`。此时 `stream.ts` 应在 130 行上下。

- [ ] **Step 5: Commit**

```bash
git add src/request.ts src/stream.ts
git commit -m "refactor: move chat request construction into request.ts

Model config resolution, message transformation, the stable session and record
ids, the request body, and the body encoding. Moved verbatim.

openQoderStream({ ...request, creds }) - QoderChatRequest's four fields are
exactly what OpenStreamRequest needs, so the orchestration reads as one line."
```

---

### Task 6: 抽取身份解析,消除 4 处重复

**Files:**
- Modify: `src/oauth.ts`(新增三个导出)
- Modify: `src/index.ts:74-79`、`src/index.ts:108-112`
- Modify: `src/stream.ts` 的 identity 构造段(Task 5 留下的那一段)
- Modify: `src/pat.ts:148-150`
- Modify: `src/request.ts` 的 `identity` 参数类型

**Interfaces:**
- Consumes: `buildChatRequest`(Task 5)
- Produces:
  - `export interface QoderIdentity { userID: string; name: string; email: string; machineID: string }`
  - `export function qoderIdentityDefaults(mode: string): Omit<QoderIdentity, "machineID">`
  - `export function identityFromCredentials(creds: Partial<QoderIdentity> | null | undefined, mode: string): QoderIdentity`
  - `export function resolveQoderIdentity(providerID: string, mode: string): QoderIdentity`

**与 spec 的差异(有意):** spec 只列了 `qoderIdentityDefaults` 与 `resolveQoderIdentity` 两个函数。实施时需要第三个 `identityFromCredentials`,因为 `index.ts:74-79` 已经持有 credentials 对象,若改为调用 `resolveQoderIdentity` 会重新读一次 `auth.json` —— 那是行为变化(多一次文件 I/O,且 `autoLoginQoderFromEnvironment` 刚写入的凭证与内存对象未必同步)。`resolveQoderIdentity` 因此实现为 `identityFromCredentials(getCachedCredentials("", providerID), mode)`。

- [ ] **Step 1a: 往 `cosy.ts` 加类型与默认值**

**归属先说清,避免写错再改。** `oauth.ts:9` 已 import `pat.js`,而 Step 4 要让 `pat.ts` 复用默认值 —— 若默认值放在 `oauth.ts`,`pat.ts` 反向 import 就形成 `oauth → pat → oauth` 循环。`cosy.ts` 是所有模块的叶子(零项目内 import),且已定义这两个函数需要的 `isQoderCNMode` 与 `getQoderUserEmailFallback`,故**类型与默认值归 `cosy.ts`,读取逻辑归 `oauth.ts`**。

在 `cosy.ts` 的 `getQoderUserEmailFallback`(第 178-180 行)之后追加:

```ts
/** Identity fields COSY signing needs. */
export interface QoderIdentity {
  userID: string;
  name: string;
  email: string;
  machineID: string;
}

/** The placeholders used when the auth store has no answer. */
export function qoderIdentityDefaults(mode: string): Omit<QoderIdentity, "machineID"> {
  return {
    userID: "qoder-user",
    name: isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User",
    email: getQoderUserEmailFallback(mode),
  };
}
```

两个依赖都在 `cosy.ts` 内部,无需新增 import。

- [ ] **Step 1b: 往 `oauth.ts` 加两个读取函数**

置于 `getCachedCredentials` 之后:

```ts
/** Fill an already-loaded credentials object's gaps with the defaults. */
export function identityFromCredentials(
  creds: Partial<QoderIdentity> | null | undefined,
  mode: string,
): QoderIdentity {
  const defaults = qoderIdentityDefaults(mode);
  return {
    userID: creds?.userID || defaults.userID,
    name: creds?.name || defaults.name,
    email: creds?.email || defaults.email,
    machineID: creds?.machineID || getMachineId(),
  };
}

/**
 * Read the identity from pi's auth store, falling back to placeholders.
 *
 * Note: `getCachedCredentials` ignores its accessToken argument, so this does
 * NOT verify that the identity belongs to the token the caller will sign with.
 * That mismatch is a known issue tracked as phase-two item 1; behaviour is
 * preserved here deliberately.
 */
export function resolveQoderIdentity(providerID: string, mode: string): QoderIdentity {
  return identityFromCredentials(getCachedCredentials("", providerID), mode);
}
```

`oauth.ts:6` 现为 `import { getMachineId, getQoderMode, getQoderRefreshURL, isQoderCNMode } from "./cosy.js";`,改为补上两个新名字:

```ts
import {
  getMachineId,
  getQoderMode,
  getQoderRefreshURL,
  isQoderCNMode,
  qoderIdentityDefaults,
  type QoderIdentity,
} from "./cosy.js";
```

- [ ] **Step 2: 改 `index.ts` 两处**

`index.ts:74-79` 现为五个位置参数,改为:

```ts
  const identity = identityFromCredentials(credentials as Partial<QoderIdentity>, mode);
  await updateQoderModelsCache(credentials.access, identity.userID, identity.name, identity.email, mode);
```

`index.ts:108-112` 改为:

```ts
        const identity = resolveQoderIdentity(providerID, mode);
        await updateQoderModelsCache(accessToken, identity.userID, identity.name, identity.email, mode);
```

注意第二处原本调用 `getCachedCredentials(accessToken, providerID)`,而 `resolveQoderIdentity` 内部传的是空串。因为该参数被实现忽略,行为完全一致 —— 这也正是阶段二第 1 项要修的东西。

改完后 `index.ts` 可能不再需要 `getCachedCredentials`、`isQoderCNMode`、`getQoderUserEmailFallback` 的 import,由 biome 的 `noUnusedImports` 报出,按报告删除。

- [ ] **Step 3: 改 `stream.ts`**

把 Task 5 留下的 identity 构造段换成一行:

```ts
      const identity = resolveQoderIdentity(model.provider, providerMode);
```

删除 `stream.ts` 中随之不再使用的 import:`getCachedCredentials`、`getMachineId`、`getQoderUserEmailFallback`。`isQoderCNMode` 仍被第 410-415 行的凭证缺失错误信息使用,保留。

- [ ] **Step 4: 改 `pat.ts` 复用默认值**

`pat.ts:148-150` 现为:

```ts
    email: email || getQoderUserEmailFallback(mode),
    name: name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User"),
```

改为:

```ts
    email: email || defaults.email,
    name: name || defaults.name,
```

并在函数体开头加 `const defaults = qoderIdentityDefaults(mode);`。

`pat.ts` 从 `cosy.js` import `qoderIdentityDefaults`(第 3-9 行的 import 块里加一个名字)。归属理由见 Step 1a —— 默认值放在 `cosy.ts` 正是为了让这一行 import 不会成环。

- [ ] **Step 5: 改 `request.ts` 的参数类型**

`buildChatRequest` 的 `identity` 参数从结构化字面量改为:

```ts
import type { QoderIdentity } from "./cosy.js";
// ...
  identity: QoderIdentity;
```

- [ ] **Step 6: 验证**

```bash
npm run check && npm run lint && npx vitest run
```

Expected: `Tests 152 passed`。

`oauth.test.ts` 的 5 个测试覆盖 `autoLoginQoderFromEnvironment` 与 `getCachedCredentials`,它们绿了说明凭证路径没被改坏。

- [ ] **Step 7: Commit**

```bash
git add src/cosy.ts src/oauth.ts src/index.ts src/stream.ts src/request.ts src/pat.ts
git commit -m "refactor: collapse the identity fallback duplicated in four places

index.ts had it twice, stream.ts once, and pat.ts defined the same defaults for
its own purpose. QoderIdentity plus qoderIdentityDefaults live in cosy.ts (the
leaf everything already depends on - putting them in oauth.ts would make pat.ts
import it and close a cycle), and oauth.ts adds identityFromCredentials for
callers that already hold a credentials object plus resolveQoderIdentity for
those that do not.

identityFromCredentials exists because index.ts already has the credentials in
hand: routing it through resolveQoderIdentity would re-read auth.json, which is
a behaviour change.

resolveQoderIdentity keeps getCachedCredentials's habit of ignoring its
accessToken argument, so the uid/token mismatch is unchanged - fixing it is
phase two, and now it is one place instead of four."
```

---

### Task 7: 合并 `stableID`,优化 `splitSSEData`

本 Task 是两处**有意的行为等价改写**,每处附带差分测试证明输出不变。与前面的纯搬移分开提交。

**Files:**
- Modify: `src/request.ts`(两个 hash 函数合一)
- Modify: `src/sse.ts`(`splitSSEData` 改单趟扫描)
- Create: `src/__tests__/request.test.ts`
- Modify: `src/__tests__/sse.test.ts`(补差分测试)

**Interfaces:**
- Consumes: `buildChatRequest`(Task 5)、`splitSSEData`(Task 2)
- Produces: `export function stableID(prefix: string, parts: Iterable<string>): string`(从 `request.ts` 导出,仅为测试可见)

- [ ] **Step 1: 写 `stableID` 的差分测试**

创建 `src/__tests__/request.test.ts`。测试内联旧实现作为 oracle —— 这与 `qoder-encoding.test.ts` 验证编码重写的做法一致(见 `47bd26d`)。

```ts
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableID } from "../request.js";

/** The pre-merge implementation, kept here as a differential oracle. */
function legacyStableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

/** The pre-merge stableChatRecordID, kept here as a differential oracle. */
function legacyChatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update("\0");
  hash.update(model);
  for (const msg of messages) {
    if (msg?.role) {
      hash.update("\0");
      hash.update(msg.role);
    }
    if (msg?.content) {
      hash.update("\0");
      hash.update(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    }
  }
  if (tools) {
    hash.update("\0");
    hash.update(JSON.stringify(tools));
  }
  hash.update("\0");
  hash.update(`mt=${maxTokens}`);
  return hash.digest("hex").slice(0, 16);
}

describe("stableID", () => {
  it("matches the pre-merge stableHash for session ids", () => {
    expect(stableID("qoder-session", ["user-1", "dmodel"])).toBe(legacyStableHash("qoder-session", "user-1", "dmodel"));
  });

  it("matches for empty parts", () => {
    expect(stableID("qoder-session", [])).toBe(legacyStableHash("qoder-session"));
  });

  it("matches for parts containing NUL and multibyte text", () => {
    // The separator is \0, so a part that itself contains \0 must hash the same
    // way in both implementations or ids would silently diverge.
    expect(stableID("p", ["a\0b", "中文"])).toBe(legacyStableHash("p", "a\0b", "中文"));
  });

  it("distinguishes different part boundaries", () => {
    expect(stableID("p", ["ab", "c"])).not.toBe(stableID("p", ["a", "bc"]));
  });

  it("returns 16 hex characters", () => {
    expect(stableID("p", ["x"])).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/request.test.ts`
Expected: FAIL,`stableID` 未从 `request.js` 导出。

- [ ] **Step 3: 实现 `stableID`,删除两个旧函数**

在 `request.ts` 中,用以下实现取代 `stableHash` 与 `stableChatRecordID`:

```ts
/** First 16 hex chars of sha256 over a domain prefix plus NUL-separated parts. */
export function stableID(prefix: string, parts: Iterable<string>): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex").slice(0, 16);
}

/** The parts that identify one chat turn, in the order they are hashed. */
function* chatRecordParts(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): Generator<string> {
  yield model;
  for (const msg of messages) {
    if (msg?.role) yield msg.role;
    if (msg?.content) yield typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  }
  if (tools) yield JSON.stringify(tools);
  yield `mt=${maxTokens}`;
}
```

两处调用点改为:

```ts
const stablePart = stableID("qoder-session", [identity.userID, qoderModel]);
// ...
const recordID = stableID("qoder-record", chatRecordParts(qoderModel, normalizedMessages, toolsRaw, maxTokens));
```

等价性论证:旧 `stableChatRecordID` 依次 update 的是 `"qoder-record"`、`\0`+model、每条消息的 `\0`+role 与 `\0`+content、`\0`+tools JSON、`\0`+`mt=N`。`chatRecordParts` 按同一顺序 yield 同样的字符串,而 `stableID` 在每个 part 前插入 `\0` —— 逐字节一致。

- [ ] **Step 4: 给 `chatRecordParts` 补差分测试**

在 `request.test.ts` 中追加:

```ts
describe("chat record id", () => {
  const cases: Array<{
    name: string;
    messages: Array<{ role?: string; content?: unknown }>;
    tools: unknown;
  }> = [
    { name: "empty history", messages: [], tools: undefined },
    { name: "string content", messages: [{ role: "user", content: "hi" }], tools: undefined },
    {
      name: "array content",
      messages: [{ role: "assistant", content: [{ type: "text", text: "a" }] }],
      tools: undefined,
    },
    { name: "role with no content", messages: [{ role: "user" }], tools: undefined },
    { name: "content with no role", messages: [{ content: "orphan" }], tools: undefined },
    { name: "falsy content is skipped", messages: [{ role: "user", content: "" }], tools: undefined },
    { name: "with tools", messages: [{ role: "user", content: "hi" }], tools: [{ name: "bash" }] },
    { name: "empty tools array is falsy-checked", messages: [], tools: [] },
  ];

  for (const { name, messages, tools } of cases) {
    it(`matches the pre-merge implementation: ${name}`, () => {
      expect(stableID("qoder-record", chatRecordPartsForTest("dmodel", messages, tools, 32768))).toBe(
        legacyChatRecordID("dmodel", messages, tools, 32768),
      );
    });
  }
});
```

这要求 `chatRecordParts` 也从 `request.ts` 导出。以 `chatRecordPartsForTest` 之名 import 会造成混淆,改为直接导出 `chatRecordParts` 并在测试中同名 import。注意第 8 个 case:`tools: []` 是 truthy,所以旧实现会 hash `"[]"` —— 生成器必须保持同一判断(`if (tools)`,不是 `if (tools?.length)`),否则这个 case 会失败。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/__tests__/request.test.ts`
Expected: `Tests 13 passed`(5 + 8)。

- [ ] **Step 6: 给 `splitSSEData` 补差分测试**

在 `src/__tests__/sse.test.ts` 追加:

```ts
/** The pre-optimisation implementation, kept as a differential oracle. */
function legacySplitSSEData(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  while (true) {
    const lineEnd = rest.indexOf("\n");
    if (lineEnd === -1) break;
    const line = rest.substring(0, lineEnd).trim();
    rest = rest.substring(lineEnd + 1);
    if (!line.startsWith("data:")) continue;
    payloads.push(line.substring(5).trim());
  }
  return { payloads, rest };
}

describe("splitSSEData equals the pre-optimisation implementation", () => {
  const inputs = [
    "",
    "\n",
    "data:a\n",
    "data:a\ndata:b\n",
    "data:a\n\ndata:b\n\n",
    "data:partial",
    "event:x\ndata:y\n:comment\n",
    "data:a\r\ndata:b\r\n",
    "data:\n",
    "data:   spaced   \ndata:tail",
    "notdata\ndata:ok\n",
    "\n\n\n\n",
  ];

  for (const input of inputs) {
    it(`matches for ${JSON.stringify(input)}`, () => {
      expect(splitSSEData(input)).toEqual(legacySplitSSEData(input));
    });
  }
});
```

- [ ] **Step 7: 改 `splitSSEData` 为单趟扫描**

```ts
export function splitSSEData(buffer: string): SSESplit {
  const payloads: string[] = [];
  let lineStart = 0;
  while (true) {
    const lineEnd = buffer.indexOf("\n", lineStart);
    if (lineEnd === -1) break;
    const line = buffer.slice(lineStart, lineEnd).trim();
    lineStart = lineEnd + 1;
    if (line.startsWith("data:")) payloads.push(line.slice(5).trim());
  }
  return { payloads, rest: lineStart === 0 ? buffer : buffer.slice(lineStart) };
}
```

改动理由:旧版每消费一行执行一次 `rest = rest.substring(lineEnd + 1)`,含 k 行的 chunk 要复制剩余部分 k 次。新版只在末尾切一次。`lineStart === 0 ? buffer : buffer.slice(lineStart)` 这个分支避免了无换行时的一次无谓复制。

- [ ] **Step 8: 验证**

```bash
npm run check && npm run lint && npx vitest run
```

Expected: `Tests 177 passed`(152 + 13 + 12)。

- [ ] **Step 9: Commit**

```bash
git add src/request.ts src/sse.ts src/__tests__/request.test.ts src/__tests__/sse.test.ts
git commit -m "refactor: merge the two stable-id helpers, make SSE splitting single-pass

stableHash and stableChatRecordID were the same construction - sha256 over a
domain prefix plus NUL-separated parts, truncated to 16 hex chars. stableID
takes an Iterable and chatRecordParts yields the turn's parts in the order the
old function hashed them.

splitSSEData no longer reslices the remaining buffer once per line; a chunk with
k lines copied the tail k times.

Both rewrites keep the pre-existing implementation inline in the tests as a
differential oracle, the same way qoder-encoding's rewrite was verified."
```

---

### Task 8: 清理剩余死代码

**Files:**
- Modify: `src/request.ts`(`maxTokens` 恒真分支)

`completion_tokens_details` 字段已在 Task 4 Step 3 随 `QoderUsage` 的定义一并删除,此处不再重复。

**Interfaces:**
- Consumes: `buildChatRequest`(Task 5)
- Produces: 无接口变化

- [ ] **Step 1: 定位并确认恒真分支**

在 `request.ts` 中找到搬移自 `stream.ts:466-472` 的这段:

```ts
  let maxTokens = 32768;
  if (maxOutputTokens > 0) {
    maxTokens = maxOutputTokens;
  }
  if (options?.maxTokens && options.maxTokens < maxTokens) {
    maxTokens = options.maxTokens;
  }
```

其上游是 `const maxOutputTokens = modelConfig.max_output_tokens || 32768;` —— `||` 保证它恒为正数,故第 1 行的初值与第 2 行的判断都不可能生效。

- [ ] **Step 2: 简化**

```ts
  // maxOutputTokens is `modelConfig.max_output_tokens || 32768`, so it is always
  // positive; the old `if (maxOutputTokens > 0)` guard could never fail.
  let maxTokens = maxOutputTokens;
  if (options?.maxTokens && options.maxTokens < maxTokens) {
    maxTokens = options.maxTokens;
  }
```

- [ ] **Step 3: 验证**

```bash
npm run check && npm run lint && npx vitest run
```

Expected: `Tests 177 passed`。

`stream.test.ts` 中没有直接断言 `max_tokens` 的测试,但 `recordID` 把 `maxTokens` hash 进去,而 `request.test.ts` 的差分测试固定传 32768 —— 两者都不会因这次简化改变。若有测试失败,说明 `maxOutputTokens` 的上游并非恒正,需重新核对。

- [ ] **Step 4: 确认最终行数达标**

```bash
wc -l src/*.ts | sort -rn
```

Expected(允许 ±15 行偏差):

| 文件 | 目标 |
| --- | --- |
| `models-static.ts` | ~385 |
| `events.ts` | ~300 |
| `transport.ts` | ~210 |
| `cosy.ts` | ~330(Task 6 加了 ~20 行) |
| `oauth.ts` | ~270 |
| `transform.ts` | 215 |
| `thinking-parser.ts` | 244 |
| `models.ts` | ~180 |
| `request.ts` | ~160 |
| `stream.ts` | ~105 |
| `sse.ts` | ~40 |

`stream.ts` 若显著超过 120 行,说明有该搬走的东西留下了 —— 回查 Task 4/5 是否漏搬。

- [ ] **Step 5: Commit**

```bash
git add src/request.ts
git commit -m "refactor: drop the max_tokens branch that could never be false

maxOutputTokens is \`modelConfig.max_output_tokens || 32768\`, so the
\`if (maxOutputTokens > 0)\` guard and the 32768 initialiser it guarded were
both dead."
```

---

## 完成标准

阶段一完成时必须同时满足:

1. `npm run check`、`npm run lint`、`npx vitest run` 全绿,测试数 177
2. 138 个原有测试的**断言一字未改** —— 唯一改动是 `models.test.ts` 的 import 路径与 `oauth.test.ts` 删除的两行空转 mock
3. `src/stream.ts` ≤ 120 行
4. `src/transport.ts` 中不出现任何 pi 类型名(`AssistantMessage`、`Model`、`Context`、`SimpleStreamOptions`)
5. `src/events.ts` 中不出现 `fetch`
6. `src/sse.ts` 无 import 语句
7. 8 个 commit,每个只动一个关注点

用以下命令核验第 4、5、6 条:

```bash
grep -nE "AssistantMessage|SimpleStreamOptions|\bContext\b|Model<" src/transport.ts || echo "transport.ts: clean"
grep -n "fetch" src/events.ts || echo "events.ts: clean"
grep -n "^import" src/sse.ts || echo "sse.ts: no imports"
```

三条都应打印 `clean` / `no imports`。

## 自审记录

写完本计划后对照 spec 的复查结果:

**Spec 覆盖检查。** spec 的 8 步实施顺序逐项对应 Task 1-8。spec 列出的每个接口都有定义它的 Task:`SSESplit`/`splitSSEData`(T2)、`QoderEventTranslator`/`mapUsage`/`QoderUsage`(T4)、`OpenStreamRequest`/`OpenedQoderStream`/`openQoderStream`(T3)、`QoderChatRequest`/`buildChatRequest`(T5)、`QoderIdentity`/`qoderIdentityDefaults`/`resolveQoderIdentity`(T6)、`stableID`(T7)。spec 的两处测试同步(`models.test.ts`、`oauth.test.ts`)在 T1 Step 5。无遗漏。

**写计划时发现并已回修 spec 的两处设计缺陷。** 二者不是"计划偏离 spec",而是 spec 原文有错,已在同一轮提交中改正:

1. **spec 漏了一个必需的函数。** 原文只列 `qoderIdentityDefaults` 与 `resolveQoderIdentity`,但 `index.ts:74-79` 已持有 credentials 对象,改走 `resolveQoderIdentity` 会多读一次 `auth.json` —— 构成行为变化,违反阶段一前提。故补第三个导出 `identityFromCredentials`,`resolveQoderIdentity` 实现为它与 `getCachedCredentials` 的组合。
2. **spec 把身份函数全放 `oauth.ts`,会形成循环依赖。** `oauth.ts:9` 已 import `pat.js`,而 `pat.ts` 需要复用默认值,反向 import 即成 `oauth → pat → oauth` 环。已验证 `cosy.ts` 零项目内 import(是叶子)且已定义所需的 `isQoderCNMode` 与 `getQoderUserEmailFallback`,故类型与默认值归 `cosy.ts`、读取逻辑归 `oauth.ts`。spec 的目标文件布局表随之改正:`cosy.ts` 由"不动"改为 310 → ~330,`pat.ts` 由"不动"改为"仅改两行"。

**计划自身修掉的两处内部矛盾:**

1. Global Constraints 原写"不改 `cosy.ts`…唯一例外是 Task 6 改 `pat.ts` 两行",与 Task 6 要往 `cosy.ts` 加类型直接冲突。已改为明确列出 Task 6 会动 `cosy.ts` 与 `pat.ts` 两个文件。
2. Task 6 原 Step 1 让执行者把四个声明全写进 `oauth.ts`,却在 Step 4 末尾才说"执行 Step 1 时按此调整" —— 按序执行会先写错再返工。已拆为 Step 1a(`cosy.ts`)与 Step 1b(`oauth.ts`),归属理由前置到 1a。

**占位符扫描。** 无 `TBD`/`TODO`/`待补`。所有代码步骤都含可直接粘贴的真实代码,唯一的例外是 T4 Step 6 中 `handleDelta`/`handleFinishReason`/`finalize` 三个方法体标为"逐行搬移 stream.ts:648-775 等" —— 这是搬移指令而非占位符:它指向精确行号,且 Global Constraints 已规定"除 import 路径与 export 关键字外不改一个字符"。把这 200 行原文抄进计划不会增加信息量,反而会与源文件产生第二份需同步的副本。

**类型一致性检查。** `QoderChatRequest` 的四个字段(`encodedBytes`、`qoderModel`、`modelSource`、`chatURL`)与 `OpenStreamRequest` 除 `callerSignal`/`creds` 外的四个字段同名同类型,故 T5 的 `openQoderStream({ ...request, ... })` 成立。`QoderIdentity` 的四字段与 `OpenStreamRequest.creds` 除 `authToken` 外一致,故 `{ ...identity, authToken: accessToken }` 成立。`mapUsage` 的返回类型是 `AssistantMessage["usage"]` 的五键子集,故 T4 的 `Object.assign(this.output.usage, ...)` 不会覆盖 `cost`。T7 的 `stableID(prefix, parts)` 与 T5 搬入的两处调用点签名匹配。

**测试计数一致性。** 138(现有)+ 9(T2 sse)+ 5(T4 mapUsage)+ 13(T7 request)+ 12(T7 sse 差分)= 177,与完成标准第 1 条一致。
