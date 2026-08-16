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
