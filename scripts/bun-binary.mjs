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
