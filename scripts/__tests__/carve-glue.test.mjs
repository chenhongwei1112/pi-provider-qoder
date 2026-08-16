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
  "function zzAuthFields(s) { return s; }",
  "function zzRawDecrypt(s) { return s; }",
  "function zzProfile(s) { return s; }",
  "var bindgenMod = {};",
  // 低层 wasm-bindgen 表：snake_case，且故意也带一个 decrypt_server_response，
  // 以证明它不会和高层表的 camelCase decryptServerResponse 串味。
  "CD(bindgenMod, { profile_encrypt: () => zzProfile, generate_runtime_auth_fields: () => zzAuthFields, decrypt_server_response: () => zzRawDecrypt });",
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

  it("re-exports generate_runtime_auth_fields from the snake_case bindgen map", () => {
    const out = carveGlue(PRETTY);
    expect(out).toContain("zzAuthFields as generate_runtime_auth_fields");
    // 两张表各归各位：camelCase 的仍来自高层表。
    expect(out).toContain("zzDecrypt as decryptServerResponse");
    expect(out).not.toContain("as decrypt_server_response");
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
