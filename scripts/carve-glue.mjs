/**
 * 从重排版的 qodercli bundle 里切出 wasm-bindgen 胶水，产出一个能在 node 下
 * 直接 import 的 ESM 模块。
 *
 * 为什么不手写 wasm-bindgen 宿主：那要自己实现 31 个 __wbg_* import、对象表、
 * 以及经栈指针返回结构体的 ABI，量大且每次 wasm 重建都可能变。切胶水的代价是
 * 依赖 bundle 结构，但结构靠字符串字面量锚定，且切完立刻自证（Task 4 的测试
 * 会拿它跑出真实请求头）。锚点失效时是响亮的报错，不是静默的错结果。
 *
 * 所有定位都只依赖两样东西：源码里的稳定字符串字面量，和 esbuild 输出的行形状。
 * 压缩后的标识符（`J2`、`XAA`、`M9A`、`_`……）逐次构建随机化，一律反查，不硬编码。
 */
const RUNTIME_END_MARKER = "WA = import.meta.require";
const ENV_MAP_MARKER = "getClientMetadata: () => ";
const WASM_MAP_MARKER = "prepareWasmAuthenticatedRequest: () => ";
// 低层 wasm-bindgen 模块的导出映射（pretty.mjs:415），名字是 Rust 侧的 snake_case，
// 和高层包装模块（WASM_MAP_MARKER 那张）是两张不同的表：后者另有一个 camelCase 的
// decryptServerResponse，别混。锚点用 Rust 函数名本身，压缩不会改它。
const BINDGEN_MAP_MARKER = "generate_runtime_auth_fields: () => ";
const ENV_INIT_MARKER = '"CLIENT_TYPE"';

const WANTED = [
  "initWasm",
  "createContext",
  "prepareWasmAuthenticatedRequest",
  "headersMapToRecord",
  "withWasmContextRetry",
  "decryptServerResponse",
];

// 按真实 snake_case 名导出，不起 camelCase 别名：台账（差异第 14/50 行）就是按这个
// 名字引用官方导出的，可追溯性优先于 JS 命名风格。
const BINDGEN_WANTED = ["generate_runtime_auth_fields"];

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

/** 从一张映射里反查一组名字，缺任何一个都响亮报错。 */
function resolveWanted(map, wanted, label) {
  const resolved = new Map();
  for (const name of wanted) {
    const ident = map.get(name);
    if (!ident) throw new Error(`carve: marker not found: ${name} in ${label} export map`);
    resolved.set(name, ident);
  }
  return resolved;
}

/**
 * 找 esbuild 的惰性模块初始化 helper：`var <ident> = (A, H) => () => (A && (H = A(A = 0)), H);`
 * 名字随机（真实 bundle 里恰好是 `_`），所以按形状认，并要求两个形参在体内的
 * 用法完全对上，避免误认成别的一行 helper。
 */
function findInitHelper(lines, limit) {
  const re =
    /^var ([A-Za-z_$][\w$]*) = \(([A-Za-z_$][\w$]*), ([A-Za-z_$][\w$]*)\) => \(\) => \(\2 && \(\3 = \2\(\2 = 0\)\), \3\);$/;
  for (let i = 0; i <= limit && i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) return m[1];
  }
  throw new Error("carve: marker not found: lazy module init helper");
}

/** 找 `var <ident> = <helper>(() => {`：向前用于 env 初始化器，向后用于 wasm 初始化器。 */
function findInitialiser(lines, helper, from, direction) {
  const re = new RegExp(`^var ([A-Za-z_$][\\w$]*) = ${helper}\\(\\(\\) => \\{$`);
  for (let i = from; i >= 0 && i < lines.length; i += direction) {
    const m = lines[i].match(re);
    if (m) return { name: m[1], line: i };
  }
  throw new Error("carve: marker not found: enclosing module initialiser");
}

export function carveGlue(prettySource) {
  const lines = prettySource.split("\n");

  const runtimeEnd = findLine(lines, RUNTIME_END_MARKER);
  const helper = findInitHelper(lines, runtimeEnd);
  const envMapLine = findLine(lines, ENV_MAP_MARKER);
  const wasmMapLine = findLine(lines, WASM_MAP_MARKER);
  const bindgenMapLine = findLine(lines, BINDGEN_MAP_MARKER);

  // 胶水模块的收尾是紧跟导出映射的 `var <ident> = <helper>(() => { ... });`。
  // 从初始化器自己那行开始找 `});`，不是从映射行开始——映射行到初始化器之间
  // 若出现别的收尾行，从映射行扫会切早。
  const wasmInit = findInitialiser(lines, helper, wasmMapLine, 1);
  let bodyEnd = -1;
  for (let i = wasmInit.line + 1; i < lines.length; i++) {
    if (lines[i] === "});") {
      bodyEnd = i;
      break;
    }
  }
  if (bodyEnd < 0) throw new Error("carve: marker not found: wasm module initialiser terminator");

  const envInit = findInitialiser(lines, helper, findLine(lines, ENV_INIT_MARKER), -1);
  if (envInit.line <= envMapLine) {
    throw new Error("carve: marker not found: env module initialiser after its export map");
  }

  const envMap = parseExportMap(lines[envMapLine]);
  const resolved = resolveWanted(parseExportMap(lines[wasmMapLine]), WANTED, "wasm");
  // 低层映射必须落在切出来的正文里，否则导出的是正文之外的标识符，模块一 import 就炸。
  if (bindgenMapLine < envMapLine - 1 || bindgenMapLine > bodyEnd) {
    throw new Error("carve: marker not found: bindgen export map inside the carved body");
  }
  const bindgenResolved = resolveWanted(parseExportMap(lines[bindgenMapLine]), BINDGEN_WANTED, "bindgen");
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
  if (body.includes("import.meta.require")) {
    throw new Error("carve: unexpected import.meta.require inside the carved body");
  }

  const exportPairs = [
    ...WANTED.map((name) => `${resolved.get(name)} as ${name}`),
    ...BINDGEN_WANTED.map((name) => `${bindgenResolved.get(name)} as ${name}`),
    `${metaIdent} as getClientMetadata`,
    `${envInit.name} as initEnvModule`,
    `${wasmInit.name} as initWasmModule`,
  ];

  return [
    'import { createRequire as __createRequire } from "node:module";',
    // 从 data: URL 求值时 import.meta.url 不是 file:，createRequire 会抛，退回 cwd。
    'const __bunRequire = __createRequire(import.meta.url.startsWith("file:") ? import.meta.url : `${process.cwd()}/`);',
    runtime,
    body,
    `export { ${exportPairs.join(", ")} };`,
    "",
  ].join("\n");
}
