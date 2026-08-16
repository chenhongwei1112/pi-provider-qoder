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
