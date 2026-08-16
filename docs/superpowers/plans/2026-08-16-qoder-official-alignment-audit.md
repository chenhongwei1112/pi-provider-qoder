# Qoder 官方实现对齐审计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一套可复现的取证与比对工具，产出 `omp-provider-qoder` 与 `qodercli` 官方实现的逐条差异台账，并把签名层的官方行为固化成回归测试向量。

**Architecture:** 三层。取证层从本地 `qodercli` 的 Bun 单文件可执行里解包主 bundle、`chat.proto` 和 `qoder_auth_wasm_bg.wasm`；预言机层加载官方 WASM，对固定输入集产出权威的 URL、请求头、编码后 body；审计层把预言机输出与插件实现逐字段比对，结论写入台账并冻结成测试向量。第一阶段不修改插件运行时行为（Task 5 是唯一例外，纯函数抽取，行为不变）。

**Tech Stack:** Node 22（`node scripts/*.mjs` 直跑，不用 tsx 也不加 flag）、vitest 4、esbuild（已在 devDependencies）、WebAssembly。不新增任何依赖。

## Global Constraints

- 目标 `qodercli` 版本：**1.1.23**，路径 `~/.qoder/bin/qodercli/qodercli-1.1.23`（129 MB ELF）。
- 取证产物一律写入 `.qoder-audit/<version>/`，该目录 **必须 gitignore**。官方代码及其派生产物**不得提交**。
- `scripts/` 下全部用 `.mjs`：`tsconfig.json` 的 `include` 只有 `src`，`npm run check` 不覆盖 scripts；`biome.json` 的 `files.includes` 也只有 `src/**`、`test/**`、`*.ts`、`*.json`，scripts 不参与 lint。沿用这个现状，不要改这两个配置。
- 落在 `src/**` 下的新文件（含 `src/__tests__/fixtures/*.json`）会被 biome 检查：2 空格缩进、行宽 120、JSON 不带尾逗号。
- 测试命令：`npx vitest run <path>` 跑单文件，`npm test` 跑全量。类型检查 `npm run check`。
- **硬规则**：凡属 WASM 覆盖范围（URL、请求头、签名、请求体编码、响应解密）的结论，必须由预言机实跑输出支撑。字符串搜索只用于定位，不得作为结论——审计过程中已有三条字符串推断结论被实测推翻，见 spec §5。
- 插件的请求头分散在 `src/cosy.ts:321-341`（`buildAuthHeaders`）和 `src/transport.ts:201-209`（`fetch` 调用点）两处。任何头部比对必须以两者合并后的结果为单位。
- commit message 用仓库现有风格（`feat:` / `test:` / `docs:` / `refactor:`），不加 `Co-authored-by` 或任何 AI 署名 trailer。

---

### Task 1: Bun 二进制解包器

Bun 单文件可执行把所有内嵌模块以 `\0` + `/$bunfs/root/<name>` + `\0` + `<contents>` 的形式顺序排列在主 bundle 之后。用这个锚点定位，比解析尾部的 offsets 结构稳得多——offsets 结构里的字段含义随 Bun 版本变化，而锚点是布局本身。

**Files:**
- Create: `scripts/bun-binary.mjs`
- Test: `scripts/__tests__/bun-binary.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `parseBunPayload(buf: Buffer) => { bundle: { start: number, end: number }, modules: Array<{ name: string, anchor: number, contentStart: number, contentEnd: number }> }` — `contentEnd` 为 `-1` 表示该模块是最后一个，长度未知。
  - `readTextModule(buf: Buffer, modules, suffix: string) => Buffer`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/__tests__/bun-binary.test.mjs`：

```js
import { describe, expect, it } from "vitest";
import { parseBunPayload, readTextModule } from "../bun-binary.mjs";

const SHEBANG = "#!/usr/bin/env node\n// @bun";

/**
 * 合成一个与真实 Bun 可执行同布局的载荷：
 * [宿主机器码占位][主 bundle][\0 名字 \0 内容]×N[尾部]
 * bundle 里故意放一个带引号的 /$bunfs/root/ 字面量，它前面是 `"` 而不是 `\0`，
 * 解析器不能把它误认成模块名——真实 bundle 里这种字面量有几十个。
 */
function buildPayload(modules) {
  const bundle = `${SHEBANG}\nvar decoy = "/$bunfs/root/decoy.js";\nconsole.log(decoy);\n`;
  const parts = [Buffer.from("\x7fELF machine code"), Buffer.from(bundle)];
  for (const m of modules) {
    parts.push(Buffer.from(`\0${m.name}\0`), Buffer.from(m.content));
  }
  parts.push(Buffer.from("\ntrailer bytes"));
  return { buf: Buffer.concat(parts), bundle };
}

const MODULES = [
  { name: "/$bunfs/root/index-aaaa1111.js", content: "module.exports = __dirname;\n" },
  { name: "/$bunfs/root/chat-bbbb2222.proto", content: 'syntax = "proto3";\npackage model.chat;\n' },
  { name: "/$bunfs/root/SKILL-cccc3333.md", content: "# skill\n" },
];

describe("parseBunPayload", () => {
  it("locates the main bundle between the shebang and the first module anchor", () => {
    const { buf, bundle } = buildPayload(MODULES);
    const parsed = parseBunPayload(buf);
    expect(buf.toString("utf8", parsed.bundle.start, parsed.bundle.end)).toBe(bundle);
  });

  it("ignores /$bunfs/root/ string literals inside the bundle", () => {
    const { buf } = buildPayload(MODULES);
    const parsed = parseBunPayload(buf);
    expect(parsed.modules.map((m) => m.name)).toEqual(MODULES.map((m) => m.name));
  });

  it("derives each module's content range from the next module's anchor", () => {
    const { buf } = buildPayload(MODULES);
    const parsed = parseBunPayload(buf);
    expect(buf.toString("utf8", parsed.modules[0].contentStart, parsed.modules[0].contentEnd)).toBe(MODULES[0].content);
    expect(buf.toString("utf8", parsed.modules[1].contentStart, parsed.modules[1].contentEnd)).toBe(MODULES[1].content);
  });

  it("marks the last module's content end as unknown", () => {
    const { buf } = buildPayload(MODULES);
    const parsed = parseBunPayload(buf);
    expect(parsed.modules.at(-1).contentEnd).toBe(-1);
  });

  it("throws when the bundle shebang is absent", () => {
    expect(() => parseBunPayload(Buffer.from("not a bun binary"))).toThrow(/bundle shebang not found/);
  });
});

describe("readTextModule", () => {
  it("returns the exact bytes of a module selected by suffix", () => {
    const { buf } = buildPayload(MODULES);
    const { modules } = parseBunPayload(buf);
    expect(readTextModule(buf, modules, ".proto").toString()).toBe(MODULES[1].content);
  });

  it("refuses the last module, whose length is unknown", () => {
    const { buf } = buildPayload(MODULES);
    const { modules } = parseBunPayload(buf);
    expect(() => readTextModule(buf, modules, ".md")).toThrow(/last module/);
  });

  it("throws when no module matches the suffix", () => {
    const { buf } = buildPayload(MODULES);
    const { modules } = parseBunPayload(buf);
    expect(() => readTextModule(buf, modules, ".wasm")).toThrow(/no module ending in \.wasm/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run scripts/__tests__/bun-binary.test.mjs`
Expected: FAIL — `Failed to load ../bun-binary.mjs`（文件还不存在）

- [ ] **Step 3: 写最小实现**

创建 `scripts/bun-binary.mjs`：

```js
/**
 * Bun 单文件可执行的载荷布局：
 *   [宿主可执行][主 bundle]\0[模块名]\0[内容] ... [模块表][offsets][magic]
 * 模块名一律以 `/$bunfs/root/` 开头且前置一个 NUL。bundle 内部也有同样的
 * 字符串字面量，但前置字符是引号，所以带 NUL 的锚点足以区分两者。
 */
const SHEBANG = "#!/usr/bin/env node\n// @bun";
const NAME_ANCHOR = "\0/$bunfs/root/";

export function parseBunPayload(buf) {
  const bundleStart = buf.indexOf(SHEBANG);
  if (bundleStart < 0) throw new Error("bun payload: bundle shebang not found");

  const firstAnchor = buf.indexOf(NAME_ANCHOR, bundleStart);
  if (firstAnchor < 0) throw new Error("bun payload: module name region not found");

  const modules = [];
  let anchor = firstAnchor;
  while (anchor >= 0) {
    const nameStart = anchor + 1;
    const nameEnd = buf.indexOf(0, nameStart);
    if (nameEnd < 0) throw new Error("bun payload: unterminated module name");
    modules.push({
      name: buf.toString("utf8", nameStart, nameEnd),
      anchor,
      contentStart: nameEnd + 1,
      contentEnd: -1,
    });
    anchor = buf.indexOf(NAME_ANCHOR, nameEnd + 1);
  }

  // 模块 i 的内容一直延伸到模块 i+1 的锚点（那个 NUL 是 i 的终止符）。
  // 最后一个模块之后是模块表，长度无法从锚点推出，留 -1。
  for (let i = 0; i < modules.length - 1; i++) modules[i].contentEnd = modules[i + 1].anchor;

  return { bundle: { start: bundleStart, end: firstAnchor }, modules };
}

export function readTextModule(buf, modules, suffix) {
  const hit = modules.find((m) => m.name.endsWith(suffix));
  if (!hit) throw new Error(`bun payload: no module ending in ${suffix}`);
  if (hit.contentEnd < 0) throw new Error(`bun payload: ${hit.name} is the last module; its length is unknown`);
  return buf.subarray(hit.contentStart, hit.contentEnd);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/__tests__/bun-binary.test.mjs`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add scripts/bun-binary.mjs scripts/__tests__/bun-binary.test.mjs
git commit -m "feat: parse bun standalone payloads by module-name anchor"
```

---

### Task 2: 抽取 CLI

**Files:**
- Create: `scripts/extract-qodercli.mjs`
- Modify: `.gitignore`（追加 `.qoder-audit/`）
- Modify: `package.json:21-31`（追加 `audit:extract` script）

**Interfaces:**
- Consumes: `parseBunPayload`、`readTextModule`（Task 1）
- Produces: `.qoder-audit/<version>/` 下五个文件 —— `bundle.js`（压缩原文）、`pretty.mjs`（esbuild 重排版）、`chat.proto`、`qoder_auth_wasm_bg.wasm`、`modules.json`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/__tests__/extract-qodercli.test.mjs`。这个测试断言选择逻辑，不依赖 129 MB 的真实二进制：

```js
import { describe, expect, it } from "vitest";
import { selectAuthWasm } from "../extract-qodercli.mjs";

describe("selectAuthWasm", () => {
  it("picks the base64 blob whose module exports qodercontext_new", () => {
    // 两个都是合法 wasm：一个导出 qodercontext_new，一个不导出。
    // 真实 bundle 里有 5 个 AGFzbQ 开头的 base64 块（tree-sitter 等），
    // 靠导出名筛选是唯一可靠的判据。
    const withCtx = wasmExporting("qodercontext_new");
    const without = wasmExporting("tree_sitter_bash");
    const source = `var A = "${without.toString("base64")}";\nvar B = "${withCtx.toString("base64")}";\n`;
    expect(selectAuthWasm(source).equals(withCtx)).toBe(true);
  });

  it("throws when no candidate exports qodercontext_new", () => {
    const source = `var A = "${wasmExporting("tree_sitter_bash").toString("base64")}";\n`;
    expect(() => selectAuthWasm(source)).toThrow(/qodercontext_new/);
  });
});

/** 手工拼一个最小 wasm 模块：一个 memory，按给定名字导出。 */
function wasmExporting(name) {
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  // section 5 (memory): 1 个 memory，min=1
  bytes.push(0x05, 0x03, 0x01, 0x00, 0x01);
  // section 7 (export): 1 项，name -> memory 0
  const nameBytes = [...Buffer.from(name)];
  const entry = [nameBytes.length, ...nameBytes, 0x02, 0x00];
  const body = [0x01, ...entry];
  bytes.push(0x07, body.length, ...body);
  const buf = Buffer.from(bytes);
  // 自检：确保拼出来的确实能被 WebAssembly 解析，否则测试在测自己
  new WebAssembly.Module(buf);
  return buf;
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run scripts/__tests__/extract-qodercli.test.mjs`
Expected: FAIL — 找不到 `../extract-qodercli.mjs`

- [ ] **Step 3: 写实现**

创建 `scripts/extract-qodercli.mjs`：

```js
#!/usr/bin/env node
/**
 * 把本地安装的 qodercli（Bun 单文件可执行）解包成可审计的产物。
 *
 * 用法: node scripts/extract-qodercli.mjs [路径或版本号]
 * 默认取 ~/.qoder/bin/qodercli/ 下版本号最大的那个。
 *
 * 每一步都断言，宁可报错也不产出半成品：Bun 或 qodercli 升级后布局可能变，
 * 静默产出错误的 bundle 会让后续所有审计结论失效。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseBunPayload, readTextModule } from "./bun-binary.mjs";

const QODERCLI_DIR = join(homedir(), ".qoder", "bin", "qodercli");
const OUT_ROOT = ".qoder-audit";

export function selectAuthWasm(bundleSource) {
  // 阈值只用来跳过短的无关字符串；真正的判据是导出名，所以取一个宽松的下限。
  const candidates = bundleSource.match(/"AGFzbQ[A-Za-z0-9+/=]{40,}"/g) ?? [];
  for (const quoted of candidates) {
    const bin = Buffer.from(quoted.slice(1, -1), "base64");
    let names;
    try {
      names = WebAssembly.Module.exports(new WebAssembly.Module(bin)).map((e) => e.name);
    } catch {
      continue;
    }
    if (names.includes("qodercontext_new")) return bin;
  }
  throw new Error(`extract: no embedded wasm exports qodercontext_new (checked ${candidates.length} candidates)`);
}

function resolveBinary(arg) {
  if (arg && existsSync(arg)) return arg;
  if (arg) {
    const byVersion = join(QODERCLI_DIR, `qodercli-${arg}`);
    if (existsSync(byVersion)) return byVersion;
    throw new Error(`extract: no qodercli binary at ${arg} or ${byVersion}`);
  }
  const found = readdirSync(QODERCLI_DIR)
    .filter((n) => /^qodercli-\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => compareVersions(a, b));
  if (found.length === 0) throw new Error(`extract: no qodercli-<version> binary under ${QODERCLI_DIR}`);
  return join(QODERCLI_DIR, found.at(-1));
}

function compareVersions(a, b) {
  const parse = (n) => n.replace("qodercli-", "").split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function prettyPrint(bundlePath, outPath) {
  const esbuild = join("node_modules", "esbuild", "bin", "esbuild");
  const r = spawnSync(
    process.execPath,
    [esbuild, bundlePath, "--format=esm", "--platform=node", "--target=node22", `--outfile=${outPath}`, "--log-level=error"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`extract: esbuild failed: ${r.stderr || r.stdout}`);
}

function main() {
  const binPath = resolveBinary(process.argv[2]);
  const version = basename(binPath).replace("qodercli-", "");
  const outDir = join(OUT_ROOT, version);
  mkdirSync(outDir, { recursive: true });

  const buf = readFileSync(binPath);
  const { bundle, modules } = parseBunPayload(buf);

  // bundle 尾部有一个 NUL 终止符，esbuild 会因它报 Unexpected "\x00"。
  let end = bundle.end;
  while (end > bundle.start && buf[end - 1] === 0) end--;
  const bundleBytes = buf.subarray(bundle.start, end);

  if (modules.length < 20) throw new Error(`extract: only ${modules.length} modules found; layout likely changed`);
  if (bundleBytes.length < 5_000_000) throw new Error(`extract: bundle is only ${bundleBytes.length} bytes; too small`);

  const bundlePath = join(outDir, "bundle.js");
  writeFileSync(bundlePath, bundleBytes);

  const prettyPath = join(outDir, "pretty.mjs");
  prettyPrint(bundlePath, prettyPath);

  const bundleSource = bundleBytes.toString("utf8");
  const wasm = selectAuthWasm(bundleSource);
  if (wasm.length < 100_000) throw new Error(`extract: auth wasm is only ${wasm.length} bytes; suspicious`);
  writeFileSync(join(outDir, "qoder_auth_wasm_bg.wasm"), wasm);

  const proto = readTextModule(buf, modules, ".proto");
  if (!proto.toString("utf8", 0, 40).includes("proto3")) throw new Error("extract: .proto module is not proto3 source");
  writeFileSync(join(outDir, "chat.proto"), proto);

  writeFileSync(
    join(outDir, "modules.json"),
    `${JSON.stringify({ version, binary: binPath, bundleBytes: bundleBytes.length, modules }, null, 2)}\n`,
  );

  console.log(`extracted qodercli ${version} -> ${outDir}`);
  console.log(`  bundle.js                 ${bundleBytes.length} bytes`);
  console.log(`  qoder_auth_wasm_bg.wasm   ${wasm.length} bytes`);
  console.log(`  chat.proto                ${proto.length} bytes`);
  console.log(`  modules.json              ${modules.length} modules`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/__tests__/extract-qodercli.test.mjs`
Expected: PASS，2 个用例

- [ ] **Step 5: gitignore 与 npm script**

在 `.gitignore` 末尾追加一行：

```
.qoder-audit/
```

在 `package.json` 的 `scripts` 里追加：

```json
"audit:extract": "node scripts/extract-qodercli.mjs"
```

- [ ] **Step 6: 对真实二进制实跑**

Run: `npm run audit:extract`
Expected: 输出
```
extracted qodercli 1.1.23 -> .qoder-audit/1.1.23
  bundle.js                 16838149 bytes
  qoder_auth_wasm_bg.wasm   297238 bytes
  chat.proto                8334 bytes
  modules.json              51 modules
```
这四个数字是已实测的基准值。若任一不符，说明解包逻辑或本地 qodercli 版本变了，**停下来查清原因再继续**，不要改断言迁就。

- [ ] **Step 7: 确认 git 没被污染**

Run: `git status --short`
Expected: 只有 `.gitignore`、`package.json`、`scripts/` 下的改动，`.qoder-audit/` 不出现

- [ ] **Step 8: 提交**

```bash
git add .gitignore package.json scripts/extract-qodercli.mjs scripts/__tests__/extract-qodercli.test.mjs
git commit -m "feat: extract qodercli bundle, chat.proto and auth wasm"
```

---

### Task 3: 从 bundle 切出 wasm-bindgen 胶水

官方的签名、URL、请求头、body 编码全在 WASM 里，调用它需要 wasm-bindgen 生成的 JS 胶水。胶水就在重排版 bundle 里，但标识符是逐次构建随机化的（`J2`、`XAA`、`M9A` 这类），**不能硬编码**。用稳定的字符串字面量做锚点定位，再从 `CD(...)` 导出映射里反查真实标识符。

**Files:**
- Create: `scripts/carve-glue.mjs`
- Test: `scripts/__tests__/carve-glue.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `carveGlue(prettySource: string) => string` —— 一个自包含的 ESM 源码字符串，导出 `initWasm`、`createContext`、`prepareWasmAuthenticatedRequest`、`headersMapToRecord`、`withWasmContextRetry`、`getClientMetadata`、`decryptServerResponse`、`initEnvModule`、`initWasmModule`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/__tests__/carve-glue.test.mjs`：

```js
import { describe, expect, it } from "vitest";
import { carveGlue } from "../carve-glue.mjs";

/**
 * 一段与 esbuild 输出同形的最小源码：顶层语句每条占一行、列 0 起始，
 * 标识符故意用与真实 bundle 不同的随机名，验证切分不依赖具体名字。
 */
const PRETTY = [
  "#!/usr/bin/env node",
  "var CD = (A, H) => { for (var D in H) Object.defineProperty(A, D, { get: H[D] }); };",
  "var _ = (A, H) => () => (A && (H = A(A = 0)), H);",
  "var iH = (A) => Promise.all(A), WA = import.meta.require;",
  "var envMod = {};",
  "CD(envMod, { getClientMetadata: () => zzMeta, readBrandEnv: () => zzBrand });",
  "function zzPrefix(A) { return `QODER_${A}`; }",
  "function zzMeta() { return { client_type: process.env[zzClient] ?? '5' }; }",
  "var zzClient;",
  "var envInit = _(() => {",
  '  zzClient = zzPrefix("CLIENT_TYPE");',
  "});",
  "function zzInitWasm() { return 'wasm'; }",
  "function zzCreate(a, b, c) { return { a, b, c }; }",
  "function zzPrepare(o) { return o; }",
  "function zzHeaders(m) { return m; }",
  "function zzRetry(f) { return f(); }",
  "function zzDecrypt(s) { return s; }",
  "var wasmMod = {};",
  "CD(wasmMod, { prepareWasmAuthenticatedRequest: () => zzPrepare, initWasm: () => zzInitWasm, createContext: () => zzCreate, headersMapToRecord: () => zzHeaders, withWasmContextRetry: () => zzRetry, decryptServerResponse: () => zzDecrypt });",
  "var wasmInit = _(() => {",
  "  envInit();",
  "});",
  "function unrelatedTail() { return 1; }",
  "unrelatedTail();",
].join("\n");

describe("carveGlue", () => {
  it("maps minified identifiers back through the CD export maps", () => {
    const out = carveGlue(PRETTY);
    expect(out).toContain("zzInitWasm as initWasm");
    expect(out).toContain("zzCreate as createContext");
    expect(out).toContain("zzPrepare as prepareWasmAuthenticatedRequest");
    expect(out).toContain("zzHeaders as headersMapToRecord");
    expect(out).toContain("zzRetry as withWasmContextRetry");
    expect(out).toContain("zzDecrypt as decryptServerResponse");
    expect(out).toContain("zzMeta as getClientMetadata");
  });

  it("finds the env and wasm lazy initialisers by position, not by name", () => {
    const out = carveGlue(PRETTY);
    expect(out).toContain("envInit as initEnvModule");
    expect(out).toContain("wasmInit as initWasmModule");
  });

  it("replaces bun's import.meta.require with a node createRequire shim", () => {
    const out = carveGlue(PRETTY);
    expect(out).not.toContain("import.meta.require");
    expect(out).toContain("createRequire");
  });

  it("drops the shebang and everything after the wasm module initialiser", () => {
    const out = carveGlue(PRETTY);
    expect(out.startsWith("#!")).toBe(false);
    expect(out).not.toContain("unrelatedTail");
  });

  it("produces a module that actually evaluates", async () => {
    const out = carveGlue(PRETTY);
    const url = `data:text/javascript;base64,${Buffer.from(out).toString("base64")}`;
    const mod = await import(url);
    mod.initEnvModule();
    expect(mod.getClientMetadata()).toEqual({ client_type: "5" });
  });

  it("throws a named error when a marker is missing", () => {
    expect(() => carveGlue("var a = 1;\n")).toThrow(/marker not found/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run scripts/__tests__/carve-glue.test.mjs`
Expected: FAIL — 找不到 `../carve-glue.mjs`

- [ ] **Step 3: 写实现**

创建 `scripts/carve-glue.mjs`：

```js
/**
 * 从重排版的 qodercli bundle 里切出 wasm-bindgen 胶水，产出一个能在 node 下
 * 直接 import 的 ESM 模块。
 *
 * 为什么不手写 wasm-bindgen 宿主：那要自己实现 31 个 __wbg_* import、对象表、
 * 以及经栈指针返回结构体的 ABI，量大且每次 wasm 重建都可能变。切胶水的代价是
 * 依赖 bundle 结构，但结构靠字符串字面量锚定，且切完立刻自证（Task 4 的测试
 * 会拿它跑出真实请求头）。锚点失效时是响亮的报错，不是静默的错结果。
 */
const RUNTIME_END_MARKER = "WA = import.meta.require";
const ENV_MAP_MARKER = "getClientMetadata: () => ";
const WASM_MAP_MARKER = "prepareWasmAuthenticatedRequest: () => ";
const ENV_INIT_MARKER = '"CLIENT_TYPE"';

const WANTED = [
  "initWasm",
  "createContext",
  "prepareWasmAuthenticatedRequest",
  "headersMapToRecord",
  "withWasmContextRetry",
  "decryptServerResponse",
];

function findLine(lines, needle, from = 0) {
  for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i;
  throw new Error(`carve: marker not found: ${needle}`);
}

/** 解析 `CD(x, { name: () => ident, ... })` 一行里的所有映射。 */
function parseExportMap(line) {
  const map = new Map();
  for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/** 找 `var <ident> = _(() => {`：向前用于 env 初始化器，向后用于 wasm 初始化器。 */
function findInitialiser(lines, from, direction) {
  const re = /^var ([A-Za-z_$][\w$]*) = _\(\(\) => \{$/;
  for (let i = from; i >= 0 && i < lines.length; i += direction) {
    const m = lines[i].match(re);
    if (m) return m[1];
  }
  throw new Error("carve: marker not found: enclosing module initialiser");
}

export function carveGlue(prettySource) {
  const lines = prettySource.split("\n");

  const runtimeEnd = findLine(lines, RUNTIME_END_MARKER);
  const envMapLine = findLine(lines, ENV_MAP_MARKER);
  const wasmMapLine = findLine(lines, WASM_MAP_MARKER);

  // 胶水模块的收尾是紧跟导出映射的 `var <ident> = _(() => { ... });`
  const wasmInit = findInitialiser(lines, wasmMapLine, 1);
  let bodyEnd = -1;
  for (let i = wasmMapLine; i < lines.length; i++) {
    if (lines[i] === "});") {
      bodyEnd = i;
      break;
    }
  }
  if (bodyEnd < 0) throw new Error("carve: marker not found: wasm module initialiser terminator");

  const envInit = findInitialiser(lines, findLine(lines, ENV_INIT_MARKER), -1);

  const envMap = parseExportMap(lines[envMapLine]);
  const wasmMap = parseExportMap(lines[wasmMapLine]);
  const resolved = new Map();
  for (const name of WANTED) {
    const ident = wasmMap.get(name);
    if (!ident) throw new Error(`carve: marker not found: ${name} in wasm export map`);
    resolved.set(name, ident);
  }
  const metaIdent = envMap.get("getClientMetadata");
  if (!metaIdent) throw new Error("carve: marker not found: getClientMetadata in env export map");

  // 第 0 行是 shebang，丢掉。运行时 helper 到 import.meta.require 那行为止;
  // bun 的 import.meta.require 在 node 下不存在，换成 createRequire。
  const runtime = lines
    .slice(1, runtimeEnd + 1)
    .join("\n")
    .replace(RUNTIME_END_MARKER, "WA = __bunRequire");

  // 正文从导出映射所在对象的声明行（映射行的前一行）起，到初始化器收尾。
  const body = lines.slice(envMapLine - 1, bodyEnd + 1).join("\n");

  const exportPairs = [
    ...WANTED.map((name) => `${resolved.get(name)} as ${name}`),
    `${metaIdent} as getClientMetadata`,
    `${envInit} as initEnvModule`,
    `${wasmInit} as initWasmModule`,
  ];

  return [
    'import { createRequire as __createRequire } from "node:module";',
    "const __bunRequire = __createRequire(import.meta.url);",
    runtime,
    body,
    `export { ${exportPairs.join(", ")} };`,
    "",
  ].join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/__tests__/carve-glue.test.mjs`
Expected: PASS，6 个用例

- [ ] **Step 5: 接到抽取流程里**

在 `scripts/extract-qodercli.mjs` 顶部的 import 区追加：

```js
import { carveGlue } from "./carve-glue.mjs";
```

在 `main()` 里 `prettyPrint(...)` 之后追加（`main()` 保持同步，不要改成 async）：

```js
  const glue = carveGlue(readFileSync(prettyPath, "utf8"));
  if (!glue.includes(" as prepareWasmAuthenticatedRequest")) throw new Error("extract: carved glue lost its exports");
  writeFileSync(join(outDir, "glue.mjs"), glue);
```

同时把 `main()` 末尾的输出块补一行 `glue.mjs` 的字节数。

- [ ] **Step 6: 对真实 bundle 实跑**

Run: `npm run audit:extract`
Expected: 新增一行 `glue.mjs` 输出；`.qoder-audit/1.1.23/glue.mjs` 存在

Run: `node -e "import('./.qoder-audit/1.1.23/glue.mjs').then(async m => { m.initEnvModule(); m.initWasmModule(); await m.initWasm(); console.log(JSON.stringify(m.getClientMetadata())); })"`
Expected: `{"client_type":"5","business_product":"cli","business_type":"agent","scene":"assistant"}`

这四个值是已实测的官方默认客户端身份，也是插件缺失的 `Cosy-ClientType` / `Cosy-Business-Product` / `Cosy-Business-Type` / `Cosy-Scene` 的来源。

- [ ] **Step 7: 提交**

```bash
git add scripts/carve-glue.mjs scripts/__tests__/carve-glue.test.mjs scripts/extract-qodercli.mjs
git commit -m "feat: carve the wasm-bindgen glue out of the qodercli bundle"
```

---

### Task 4: COSY 预言机

**Files:**
- Create: `scripts/cosy-oracle.mjs`
- Test: `scripts/__tests__/cosy-oracle.test.mjs`

**Interfaces:**
- Consumes: `.qoder-audit/<version>/glue.mjs`（Task 3）
- Produces:
  - `AUDIT_DIR: string`、`findAuditDir() => string | null`
  - `createOracle({ auditDir, machineId, uid, encryptUserInfo, key, cosyVersion }) => Promise<Oracle>`
  - `Oracle.clientMetadata() => { client_type, business_product, business_type, scene }`
  - `Oracle.authRequest({ endpoint, path, method, body }) => { url, headers }`
  - `Oracle.inferRequest({ endpoint, body, modelKey, modelSource }) => { url, headers, body }`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/__tests__/cosy-oracle.test.mjs`。它需要真实 WASM，所以在产物缺失时跳过——但跳过必须显式可见，不能伪装成通过：

```js
import { describe, expect, it } from "vitest";
import { createOracle, findAuditDir } from "../cosy-oracle.mjs";

const auditDir = findAuditDir();

// 产物由 `npm run audit:extract` 生成，需要本地安装 qodercli。
describe.skipIf(!auditDir)("cosy oracle against the official wasm", () => {
  const identity = {
    machineId: "0123456789abcdef0123456789abcdef",
    uid: "test-user-id",
    encryptUserInfo: "EUI",
    key: "KEY123",
    cosyVersion: "1.1.23",
  };

  it("reports the official client identity", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    expect(oracle.clientMetadata()).toEqual({
      client_type: "5",
      business_product: "cli",
      business_type: "agent",
      scene: "assistant",
    });
  });

  it("adds the /algo prefix and keeps Encode=1 on the model catalog request", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const req = oracle.authRequest({
      endpoint: "https://api3.qoder.sh",
      path: "/api/v2/model/list?Encode=1",
      method: "GET",
    });
    expect(req.url).toBe("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1");
  });

  it("signs with md5 over payload, key, date, body and the /algo-stripped path", async () => {
    const { createHash } = await import("node:crypto");
    const oracle = await createOracle({ auditDir, ...identity });
    const req = oracle.authRequest({
      endpoint: "https://api3.qoder.sh",
      path: "/api/v2/model/list?Encode=1",
      method: "GET",
    });
    const [payloadB64, signature] = req.headers.Authorization.replace("Bearer COSY.", "").split(".");
    const expected = createHash("md5")
      .update([payloadB64, req.headers["Cosy-Key"], req.headers["Cosy-Date"], "", "/api/v2/model/list"].join("\n"))
      .digest("hex");
    expect(signature).toBe(expected);
  });

  it("replays the credential-supplied user info and key verbatim", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const req = oracle.authRequest({
      endpoint: "https://api3.qoder.sh",
      path: "/api/v2/model/list?Encode=1",
      method: "GET",
    });
    const payload = JSON.parse(Buffer.from(req.headers.Authorization.split(".")[1], "base64").toString());
    expect(payload.info).toBe("EUI");
    expect(payload.version).toBe("v1");
    expect(payload.cosyVersion).toBe("1.1.23");
    expect(payload.ideVersion).toBe("");
    expect(req.headers["Cosy-Key"]).toBe("KEY123");
  });

  it("emits the business identity headers on the infer request", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const req = oracle.inferRequest({
      endpoint: "https://api3.qoder.sh",
      body: JSON.stringify({ session_id: "s-1" }),
      modelKey: "qmodel",
      modelSource: "system",
    });
    expect(req.url).toBe(
      "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation" +
        "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
    );
    expect(req.headers["Cosy-Business-Product"]).toBe("cli");
    expect(req.headers["Cosy-Business-Type"]).toBe("agent");
    expect(req.headers["Cosy-Scene"]).toBe("assistant");
    expect(req.headers["X-Model-Key"]).toBe("qmodel");
    expect(req.headers["X-Model-Source"]).toBe("system");
    expect(req.headers.Connection).toBe("keep-alive");
    // infer 请求不带这两个——它们只出现在 auth 类请求上。
    expect(req.headers["Accept-Encoding"]).toBeUndefined();
    expect(req.headers["Cosy-ClientIp"]).toBeUndefined();
  });

  it("obfuscates the infer body inside the wasm", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const body = JSON.stringify({ session_id: "s-1", messages: [{ role: "user", content: "hi" }] });
    const req = oracle.inferRequest({ endpoint: "https://api3.qoder.sh", body, modelKey: "qmodel", modelSource: "system" });
    expect(req.body).not.toBe(body);
    expect(req.body.length).toBe(Math.ceil(Buffer.byteLength(body) / 3) * 4);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run scripts/__tests__/cosy-oracle.test.mjs`
Expected: FAIL — 找不到 `../cosy-oracle.mjs`

- [ ] **Step 3: 写实现**

创建 `scripts/cosy-oracle.mjs`：

```js
/**
 * 官方 COSY 行为的预言机。加载 qodercli 自带的 WASM，对给定输入产出权威的
 * URL、请求头和编码后 body。审计里凡涉及这四项的结论都必须以它为准。
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const AUDIT_DIR = ".qoder-audit";

export function findAuditDir() {
  if (!existsSync(AUDIT_DIR)) return null;
  const versions = readdirSync(AUDIT_DIR).filter((v) => existsSync(resolve(AUDIT_DIR, v, "glue.mjs")));
  if (versions.length === 0) return null;
  versions.sort((a, b) => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });
  return resolve(AUDIT_DIR, versions.at(-1));
}

export async function createOracle({ auditDir, machineId, uid, encryptUserInfo, key, cosyVersion }) {
  const glue = await import(`file://${resolve(auditDir, "glue.mjs")}`);
  glue.initEnvModule();
  glue.initWasmModule();
  await glue.initWasm();

  // WASM 侧的 userInfoJson 就是登录响应里存下来的三段值，客户端只做回放。
  glue.createContext(machineId, cosyVersion, JSON.stringify({ uid, encrypt_user_info: encryptUserInfo, key }));

  return {
    clientMetadata: () => glue.getClientMetadata(),

    authRequest({ endpoint, path, method, body }) {
      return glue.prepareWasmAuthenticatedRequest({ endpoint, path, method, body });
    },

    inferRequest({ endpoint, body, modelKey, modelSource }) {
      const result = glue.withWasmContextRetry((ctx) => ctx.prepareInferRequest(endpoint, body, modelKey, modelSource));
      try {
        return { url: result.url, headers: glue.headersMapToRecord(result.headers), body: String(result.body) };
      } finally {
        result.free();
      }
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/__tests__/cosy-oracle.test.mjs`
Expected: PASS，6 个用例（若 `.qoder-audit/` 缺失则整个 describe 被跳过 —— 此时先跑 `npm run audit:extract`）

- [ ] **Step 5: 加 npm script**

在 `package.json` 的 `scripts` 里追加：

```json
"audit:oracle": "vitest run scripts/__tests__/cosy-oracle.test.mjs"
```

- [ ] **Step 6: 提交**

```bash
git add scripts/cosy-oracle.mjs scripts/__tests__/cosy-oracle.test.mjs package.json
git commit -m "feat: add a cosy oracle backed by the official qoder wasm"
```

---

### Task 5: 抽出可测的签名纯函数

`buildAuthHeaders` 把 md5 签名的拼装和 sigPath 的推导埋在函数体里，外部无法针对它们比对预言机。这一步把两者提成导出的纯函数，**行为完全不变**：`buildAuthHeaders` 继续调用它们，现有测试与实际请求输出保持一致。这是第一阶段唯一触碰运行时代码的改动，因为没有它就只能写"测试自己复述一遍公式"的假测试。

**Files:**
- Modify: `src/cosy.ts:228-235`（`computeSigPath` 加 `export`）、`src/cosy.ts:296-311`（抽出 `computeCosySignature`）
- Test: `src/__tests__/cosy-signature.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export function computeSigPath(urlStr: string): string`
  - `export function computeCosySignature(payloadB64: string, cosyKey: string, timestamp: string, body: Buffer | string | null, sigPath: string): string`

- [ ] **Step 1: 写失败的测试**

创建 `src/__tests__/cosy-signature.test.ts`：

```ts
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeCosySignature, computeSigPath } from "../cosy.js";

describe("computeSigPath", () => {
  it("strips the /algo prefix the gateway adds", () => {
    expect(computeSigPath("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1")).toBe("/api/v2/model/list");
  });

  it("drops the query string", () => {
    expect(
      computeSigPath(
        "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&Encode=1",
      ),
    ).toBe("/api/v2/service/pro/sse/agent_chat_generation");
  });

  it("leaves a path that has no /algo prefix alone", () => {
    expect(computeSigPath("https://openapi.qoder.sh/api/v1/userinfo")).toBe("/api/v1/userinfo");
  });
});

describe("computeCosySignature", () => {
  it("md5s payload, key, timestamp, body and sigPath joined by newlines", () => {
    const expected = crypto.createHash("md5").update(["PAYLOAD", "KEY", "1700000000", "BODY", "/api/v2/x"].join("\n")).digest("hex");
    expect(computeCosySignature("PAYLOAD", "KEY", "1700000000", "BODY", "/api/v2/x")).toBe(expected);
  });

  it("treats a null body as the empty string", () => {
    expect(computeCosySignature("P", "K", "1", null, "/p")).toBe(computeCosySignature("P", "K", "1", "", "/p"));
  });

  it("hashes a Buffer body by its bytes, not by its string form", () => {
    const bytes = Buffer.from([0xf0, 0x9f, 0x9a, 0x80]);
    expect(computeCosySignature("P", "K", "1", bytes, "/p")).toBe(computeCosySignature("P", "K", "1", "🚀", "/p"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/cosy-signature.test.ts`
Expected: FAIL — `computeCosySignature` / `computeSigPath` 未导出

- [ ] **Step 3: 改实现**

`src/cosy.ts:228` 那行加上 `export`：

```ts
export function computeSigPath(urlStr: string): string {
```

在 `computeSigPath` 后面新增：

```ts
/**
 * COSY 签名：md5(payloadB64 \n cosyKey \n timestamp \n body \n sigPath)。
 * 已用官方 WASM 逐字节验证（见 scripts/cosy-oracle.mjs）。
 *
 * 分段喂给 md5 而不是拼成一个字符串：body 是编码后的请求体，长对话下可达
 * 几百 KB，模板字符串会把它多拷两遍。
 */
export function computeCosySignature(
  payloadB64: string,
  cosyKey: string,
  timestamp: string,
  body: Buffer | string | null,
  sigPath: string,
): string {
  return crypto
    .createHash("md5")
    .update(payloadB64)
    .update("\n")
    .update(cosyKey)
    .update("\n")
    .update(timestamp)
    .update("\n")
    .update(body ?? "")
    .update("\n")
    .update(sigPath)
    .digest("hex");
}
```

把 `buildAuthHeaders` 里 `src/cosy.ts:297-311` 那段注释加 md5 链替换成调用：

```ts
  const sig = computeCosySignature(payloadB64, cosyKey, timestamp, body, sigPath);
```

- [ ] **Step 4: 跑测试确认通过，并确认没有行为回归**

Run: `npx vitest run src/__tests__/cosy-signature.test.ts`
Expected: PASS，6 个用例

Run: `npm test`
Expected: 全量通过，条数与改动前一致（这是行为不变的证据 —— `buildAuthHeaders` 的输出没有任何测试需要修改）

Run: `npm run check`
Expected: 无输出（tsc 干净）

- [ ] **Step 5: 提交**

```bash
git add src/cosy.ts src/__tests__/cosy-signature.test.ts
git commit -m "refactor: expose computeCosySignature and computeSigPath for oracle comparison"
```

---

### Task 6: 冻结官方向量并锁定差异

预言机需要本地装着 qodercli 才能跑。把它的输出冻结成 JSON，插件的回归测试就不再依赖官方安装，且任何一次头部改动都会撞上冻结的差异清单，迫使台账同步更新。

**Files:**
- Create: `src/__tests__/fixtures/cosy-oracle-vectors.json`
- Create: `src/__tests__/cosy-oracle-vectors.test.ts`
- Create: `scripts/freeze-vectors.mjs`
- Modify: `package.json`（追加 `audit:freeze` script）

**Interfaces:**
- Consumes: `createOracle`、`findAuditDir`（Task 4）；`computeCosySignature`、`computeSigPath`（Task 5）；`qoderEncodeBody`（`src/qoder-encoding.ts:53`）
- Produces: `src/__tests__/fixtures/cosy-oracle-vectors.json`，结构见下

- [ ] **Step 1: 写冻结脚本**

创建 `scripts/freeze-vectors.mjs`：

```js
/**
 * 把预言机的输出冻结成测试向量。需要本地安装 qodercli 并先跑过
 * `npm run audit:extract`。产物提交进仓库，使回归测试不依赖官方安装。
 */
import { writeFileSync } from "node:fs";
import { createOracle, findAuditDir } from "./cosy-oracle.mjs";

const IDENTITY = {
  machineId: "0123456789abcdef0123456789abcdef",
  uid: "test-user-id",
  encryptUserInfo: "EUI",
  key: "KEY123",
  cosyVersion: "1.1.23",
};

const BODY_CASES = [
  JSON.stringify({ session_id: "s-1", messages: [{ role: "user", content: "hi" }] }),
  JSON.stringify({ a: "x".repeat(1000) }),
  "{}",
  JSON.stringify({ u: "中文测试 emoji 🚀" }),
];

const auditDir = findAuditDir();
if (!auditDir) throw new Error("freeze: no .qoder-audit/<version>/glue.mjs; run npm run audit:extract first");

const oracle = await createOracle({ auditDir, ...IDENTITY });

const catalog = oracle.authRequest({
  endpoint: "https://api3.qoder.sh",
  path: "/api/v2/model/list?Encode=1",
  method: "GET",
});
const [payloadB64, signature] = catalog.headers.Authorization.replace("Bearer COSY.", "").split(".");

const infer = oracle.inferRequest({
  endpoint: "https://api3.qoder.sh",
  body: BODY_CASES[0],
  modelKey: "qmodel",
  modelSource: "system",
});

const vectors = {
  qodercliVersion: auditDir.split("/").at(-1),
  identity: IDENTITY,
  clientMetadata: oracle.clientMetadata(),
  catalogRequest: {
    url: catalog.url,
    headerNames: Object.keys(catalog.headers).sort(),
    headers: omitVolatile(catalog.headers),
  },
  inferRequest: {
    url: infer.url,
    headerNames: Object.keys(infer.headers).sort(),
    headers: omitVolatile(infer.headers),
  },
  signature: {
    payloadB64,
    payload: JSON.parse(Buffer.from(payloadB64, "base64").toString()),
    cosyKey: catalog.headers["Cosy-Key"],
    timestamp: catalog.headers["Cosy-Date"],
    body: "",
    sigPath: "/api/v2/model/list",
    md5: signature,
  },
  bodyEncoding: BODY_CASES.map((input) => ({
    input,
    encoded: oracle.inferRequest({
      endpoint: "https://api3.qoder.sh",
      body: input,
      modelKey: "qmodel",
      modelSource: "system",
    }).body,
  })),
};

/** Authorization / Cosy-Date 每次都变，冻结它们只会让测试变脆。 */
function omitVolatile(headers) {
  const { Authorization, "Cosy-Date": _date, ...stable } = headers;
  return Object.fromEntries(Object.entries(stable).sort(([a], [b]) => a.localeCompare(b)));
}

writeFileSync("src/__tests__/fixtures/cosy-oracle-vectors.json", `${JSON.stringify(vectors, null, 2)}\n`);
console.log("froze vectors for qodercli", vectors.qodercliVersion);
```

- [ ] **Step 2: 生成向量**

```bash
mkdir -p src/__tests__/fixtures
node scripts/freeze-vectors.mjs
node node_modules/@biomejs/biome/bin/biome format --write src/__tests__/fixtures/cosy-oracle-vectors.json
```

Expected: 输出 `froze vectors for qodercli 1.1.23`，文件生成

Run: `node -e "const v=require('./src/__tests__/fixtures/cosy-oracle-vectors.json'); console.log(v.catalogRequest.url); console.log(v.inferRequest.headerNames.join(' '))"`
Expected: URL 为 `https://api3.qoder.sh/algo/api/v2/model/list?Encode=1`；infer 头名里包含 `Cosy-Business-Product`、`Cosy-Business-Type`、`Cosy-Scene`、`Connection`、`X-Model-Key`、`X-Model-Source`

- [ ] **Step 3: 写向量测试**

创建 `src/__tests__/cosy-oracle-vectors.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuthHeaders, computeCosySignature, computeSigPath, getQoderChatURL } from "../cosy.js";
import { qoderEncodeBody } from "../qoder-encoding.js";

interface OracleVectors {
  qodercliVersion: string;
  identity: { machineId: string; uid: string; encryptUserInfo: string; key: string; cosyVersion: string };
  clientMetadata: Record<string, string>;
  catalogRequest: { url: string; headerNames: string[]; headers: Record<string, string> };
  inferRequest: { url: string; headerNames: string[]; headers: Record<string, string> };
  signature: {
    payloadB64: string;
    payload: Record<string, string>;
    cosyKey: string;
    timestamp: string;
    body: string;
    sigPath: string;
    md5: string;
  };
  bodyEncoding: Array<{ input: string; encoded: string }>;
}

// 用 readFileSync 而不是 `import ... with { type: "json" }`：tsconfig.json 没开
// resolveJsonModule，JSON 模块导入过不了 `npm run check`，而改 tsconfig 只为
// 一个测试不值得。
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "cosy-oracle-vectors.json"), "utf8"),
) as OracleVectors;

describe("cosy signature against frozen official vectors", () => {
  it("reproduces the official md5 signature", () => {
    const { payloadB64, cosyKey, timestamp, body, sigPath, md5 } = vectors.signature;
    expect(computeCosySignature(payloadB64, cosyKey, timestamp, body, sigPath)).toBe(md5);
  });

  it("derives the same sigPath the official client signed", () => {
    expect(computeSigPath(vectors.catalogRequest.url)).toBe(vectors.signature.sigPath);
  });

  it("builds the same Authorization payload shape", () => {
    expect(Object.keys(vectors.signature.payload).sort()).toEqual([
      "cosyVersion",
      "ideVersion",
      "info",
      "requestId",
      "version",
    ]);
    expect(vectors.signature.payload.version).toBe("v1");
    expect(vectors.signature.payload.ideVersion).toBe("");
  });
});

describe("body obfuscation against frozen official vectors", () => {
  it.each(vectors.bodyEncoding.map((c, i) => [i, c] as const))("matches the wasm output byte for byte (case %i)", (_i, c) => {
    expect(qoderEncodeBody(c.input)).toBe(c.encoded);
  });
});

describe("chat URL against frozen official vectors", () => {
  it("matches the official infer URL", () => {
    expect(getQoderChatURL("global")).toBe(vectors.inferRequest.url);
  });
});

/**
 * 已知差异清单。它现在是绿的，说明台账如实描述了当前状态;
 * 第二阶段每修掉一条头部差异，这里就会红一次 —— 那是提醒同步更新
 * docs/qoder-alignment-audit.md，不是让你放宽断言。
 */
describe("known header differences (locked, see docs/qoder-alignment-audit.md)", () => {
  const pluginHeaders = buildAuthHeaders(null, vectors.inferRequest.url, {
    userID: vectors.identity.uid,
    authToken: "token",
    name: "n",
    email: "e",
    machineID: vectors.identity.machineId,
  });
  // transport.ts:201-209 在 fetch 时并入的那几个头,预言机对比必须算进来。
  const transportHeaders = [
    "Content-Type",
    "Accept",
    "Cache-Control",
    "Accept-Encoding",
    "X-Model-Key",
    "X-Model-Source",
  ];
  const pluginNames = new Set([...Object.keys(pluginHeaders), ...transportHeaders]);
  const officialNames = new Set(vectors.inferRequest.headerNames);
  const lower = (s: Set<string>) => new Set([...s].map((n) => n.toLowerCase()));

  it("still misses exactly these official headers", () => {
    const missing = [...officialNames].filter((n) => !lower(pluginNames).has(n.toLowerCase())).sort();
    expect(missing).toEqual(["Connection", "Cosy-Business-Product", "Cosy-Business-Type", "Cosy-Scene"]);
  });

  it("still sends exactly these headers the official client does not", () => {
    const extra = [...pluginNames].filter((n) => !lower(officialNames).has(n.toLowerCase())).sort();
    expect(extra).toEqual([
      "Accept-Encoding",
      "Cosy-Bodyhash",
      "Cosy-Bodylength",
      "Cosy-Clientip",
      "Cosy-Machineos",
      "Cosy-Organization-Id",
      "Cosy-Organization-Tags",
      "Cosy-Sigpath",
      "X-Request-Id",
    ]);
  });

  it("still spells these headers with different casing than the official client", () => {
    const mismatched = [...officialNames]
      .filter((official) => {
        const hit = [...pluginNames].find((p) => p.toLowerCase() === official.toLowerCase());
        return hit !== undefined && hit !== official;
      })
      .sort();
    expect(mismatched).toEqual(["Cosy-ClientType", "Cosy-MachineId", "Cosy-MachineToken", "Cosy-MachineType"]);
  });

  it("still pins a stale Cosy-Version", () => {
    expect(pluginHeaders["Cosy-Version"]).toBe("1.1.3");
    expect(vectors.inferRequest.headers["Cosy-Version"]).toBe("1.1.23");
  });
});
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/__tests__/cosy-oracle-vectors.test.ts`
Expected: PASS。若「已知差异」三个用例里的数组对不上，**先核对实际值再改断言**——数组内容就是台账的数据来源，改错了台账也就错了。把实际值抄进断言后，同一份值必须同步写进 Task 8 的台账。

- [ ] **Step 5: 加 npm script**

在 `package.json` 的 `scripts` 里追加：

```json
"audit:freeze": "node scripts/freeze-vectors.mjs"
```

- [ ] **Step 6: 全量验证并提交**

Run: `npm test && npm run check && npm run lint`
Expected: 三者全绿

```bash
git add src/__tests__/fixtures/cosy-oracle-vectors.json src/__tests__/cosy-oracle-vectors.test.ts scripts/freeze-vectors.mjs package.json
git commit -m "test: freeze official cosy vectors and lock the known header diff"
```

---

### Task 7: 面 1 与面 2 的台账

面 1（传输层指纹）的结论已由 Task 4、6 产出；面 2（请求体构造）以 `chat.proto` 为基准。

**Files:**
- Create: `docs/qoder-alignment-audit.md`
- Read: `.qoder-audit/1.1.23/chat.proto`、`src/request.ts`、`src/transform.ts`

**Interfaces:**
- Consumes: Task 6 冻结的向量（差异数据的唯一来源）
- Produces: 台账文件，含面 1、面 2 两节

- [ ] **Step 1: 建台账骨架**

创建 `docs/qoder-alignment-audit.md`，开头写明基准与方法：

```markdown
# Qoder 官方实现对齐台账

基准：`qodercli` 1.1.23。方法与硬规则见
`docs/superpowers/specs/2026-08-16-qoder-official-alignment-audit-design.md`。

差异数据来自 `src/__tests__/fixtures/cosy-oracle-vectors.json`（由
`npm run audit:extract && npm run audit:freeze` 生成）。**改台账前先改向量。**

判定：必须对齐 / 不能对齐 / 无需对齐。风险：高（可致封禁或风控降级）/
中（静默行为劣化）/ 低（仅影响本地展示）。

| # | 面 | 项 | 官方行为 | 插件行为 | 证据 | 风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
```

- [ ] **Step 2: 填面 1 的行**

把 spec §8 的差异表逐条搬进来，每条的「证据」列填冻结向量里的具体字段路径（例如 `vectors.inferRequest.headerNames`）或 `scripts/__tests__/cosy-oracle.test.mjs` 的用例名，并补上判定。已确认的九条：`model/list` URL、`Cosy-Version`、头大小写、业务标识头、多发的头、`Connection`、`Cosy-ClientIp`、`Accept-Encoding`、`info`/`Cosy-Key` 来源、端点动态发现。

同时另起一节「已验证一致」，把 spec §8 的六条搬进来（签名公式、sigPath、Authorization payload 结构、chat URL、`Cosy-Data-Policy`、body 编码、infer 传输头），每条注明验证它的测试用例。这一节和差异表同等重要：它划定了**不要再去动**的范围。

- [ ] **Step 3: 提取 proto 的请求字段集**

Run:
```bash
node -e "const s=require('fs').readFileSync('.qoder-audit/1.1.23/chat.proto','utf8'); const m=s.match(/message ChatCompletionRequest \{[^}]*\}/s); console.log(m[0])"
```
Expected: 打印 `ChatCompletionRequest` 的完整字段列表（`model`、`messages`、`temperature`、`top_p`、`max_tokens`、`stream`、`stop`、`presence_penalty`、`frequency_penalty`、`n`、`user`、`seed`、`reasoning` 等）

- [ ] **Step 4: 对照插件实际发出的请求体**

Run: `npx vitest run src/__tests__/request-body.test.ts --reporter=verbose`
Expected: 现有用例已经钉住了插件请求体的键集与顺序，用例名即是插件行为的清单

逐字段比对 proto 与该用例钉住的键集，把差异写入台账面 2 节：proto 里有而插件不发的字段、插件发而 proto 未声明的字段、类型或包装不一致的字段（proto 用 `google.protobuf.DoubleValue` 这类 wrapper，语义是"可缺省"，与插件直接写数值的差别要记下来）。

- [ ] **Step 5: 提交**

```bash
git add docs/qoder-alignment-audit.md
git commit -m "docs: record surface 1 and 2 of the qoder alignment audit"
```

---

### Task 8: 面 3 至面 6 的台账并收尾

这四面的逻辑在 JS 层可读，按 spec §5 允许以代码阅读为证据，但每条必须标注 `pretty.mjs` 的行号。

**Files:**
- Modify: `docs/qoder-alignment-audit.md`
- Read: `.qoder-audit/1.1.23/pretty.mjs`、`src/events.ts`、`src/sse.ts`、`src/models.ts`、`src/oauth.ts`、`src/pat.ts`、`src/transport.ts`

- [ ] **Step 1: 面 3 —— 响应流解析**

在 `pretty.mjs` 里定位官方的 SSE 处理：搜 `handleSSEMessage`、`case"connected"`、`stream_error`、`reasoning_content`。把官方的事件类型全集、`stop_reason` 取值、usage 字段映射、错误体形状记下来，与 `src/events.ts`、`src/sse.ts` 逐项比对。

注意官方对目录与 chat 响应都走 `decrypt_server_response`（`pretty.mjs` 里的解密封装，Task 4 已通过 `decryptServerResponse` 暴露）。**插件是否需要解密要用预言机验证，不能靠读代码判断**——这落在 WASM 覆盖范围内。

- [ ] **Step 2: 面 4 —— 模型目录与配额**

对照官方目录解析（搜 `is_vl`、`feature_switches`、`function_switches`、`strategies`、`promotion`、`price_factor`、`server_scene`、`available_context_windows`、`default_context_window`、`supports_disabled`、`default_effort`）与 `src/models.ts`。官方按 `getClientMetadata().scene`（值 `assistant`）从响应里取子对象，插件的 scene 处理是否一致要写明。

- [ ] **Step 3: 面 5 —— 认证与身份**

对照 `/api/v1/jobToken/exchange`、`/api/v1/jobToken/refresh`（官方带 `User-Agent: qoder/<version>`）、machine id 的推导与落盘（搜 `machine_id.derive`、`machine_id.generate`、`machine_id.publish`）与 `src/pat.ts`、`src/oauth.ts`、`src/cosy.ts:237-257`。

第 9 条（`info`/`Cosy-Key` 来源）的判定在这一面定：确认官方登录响应里 `encrypt_user_info` 与 `key` 的来源字段，判断插件能否拿到。拿不到就判「不能对齐」并写明原因。

- [ ] **Step 4: 面 6 —— CN 版差异**

对照端点动态发现（搜 `/api/v3/service/region/endpoints`、`/api/v4/service/region/endpoints`、`/algo/api/v1/ping`）与插件硬编码的 `getQoderBaseUrl`。确认 CN 与全球版在签名、头、模型 key 映射上是否真有差异，还是只有域名不同。

- [ ] **Step 5: 收尾 —— 排序与统计**

台账按风险级降序排，末尾加一节统计：各风险级条数、三种判定各条数。给第二阶段一个明确的入口顺序。

- [ ] **Step 6: 校验台账自身**

Run: `npm test && npm run check && npm run lint`
Expected: 全绿

逐条检查：每条差异都有证据列且证据可定位（向量字段路径、测试用例名，或 `pretty.mjs:<行号>`）；每条都有判定，没有留空；「已验证一致」一节的每条都指向一个真实存在的测试用例。

- [ ] **Step 7: 提交**

```bash
git add docs/qoder-alignment-audit.md
git commit -m "docs: complete the qoder alignment audit ledger"
```

---

## 计划自审

**Spec 覆盖检查**

| Spec 章节 | 落地位置 |
| --- | --- |
| §3 取证方法 | Task 1、2（锚点法取代了 spec 里记的 offsets 结构解析——更稳，spec 的常量作为交叉验证保留） |
| §4 `extract-qodercli` | Task 2 |
| §4 `cosy-oracle` | Task 3、4 |
| §4 台账 | Task 7、8 |
| §5 oracle 优先硬规则 | 写入 Global Constraints；Task 8 Step 1 明确点出解密结论必须走预言机 |
| §6 六面范围 | 面 1 → Task 4/6/7；面 2 → Task 7；面 3–6 → Task 8 |
| §7 判定与分级 | Task 7 Step 1 的表头，Task 8 Step 5 的统计 |
| §8 已确认差异 | Task 6 的锁定测试 + Task 7 Step 2 |
| §9 交付物 | 四项全部有对应 Task；测试向量不依赖本地 qodercli（Task 6 冻结成 JSON） |
| §10 退路 | Task 3 的实现注释写明了为何不手写 wasm 宿主，以及锚点失效时的表现 |
| §11 阶段划分 | 本计划只做第一阶段；Task 5 是唯一的运行时改动，纯函数抽取，`npm test` 不变即为证据 |

**偏离 spec 之处（有意）**

- spec §3 记的 offsets 结构解析（`byte_count`、52 字节模块表、22 字节补偿）被 Task 1 的锚点法取代。锚点法已实测得出同样的 51 个模块和同样的 bundle 长度，且不依赖 Bun 版本相关的结构字段。spec 里的常量保留为交叉验证依据。
- spec §4 说 oracle 是 `scripts/cosy-oracle.ts`。改成 `.mjs`：`tsconfig.json` 的 `include` 只有 `src`，`.ts` 脚本既不被 tsc 检查也需要额外 loader 才能跑，而胶水本身是 JS。插件侧的比对放在 vitest 测试里（`.ts`，vitest 自带转译），职责反而更清楚。
- spec 说第一阶段不改运行时代码，Task 5 抽了两个纯函数。理由与验证方式见该 Task 开头。

**占位符扫描**：无 TBD / TODO / 「类似 Task N」/ 无代码的代码步骤。每个测试步骤都给了完整可运行的测试代码，每个实现步骤都给了完整实现。

**类型一致性检查**：`parseBunPayload` 的返回结构在 Task 1 定义、Task 2 使用，字段名一致（`bundle.start`/`bundle.end`/`modules[].contentStart`/`contentEnd`/`anchor`）。`createOracle` 的选项名在 Task 4 定义、Task 6 使用，一致（`auditDir`/`machineId`/`uid`/`encryptUserInfo`/`key`/`cosyVersion`）。`authRequest`/`inferRequest` 的返回字段（`url`/`headers`/`body`）在 Task 4、6 用法一致。`computeCosySignature` 的五个参数顺序在 Task 5 定义、Task 6 调用，一致。
