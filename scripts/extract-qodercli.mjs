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
    esbuild,
    [bundlePath, "--format=esm", "--platform=node", "--target=node22", `--outfile=${outPath}`, "--log-level=error"],
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

  // `bundle.end` 是开区间上界，正好落在首个模块锚点的 NUL 上，所以那个 NUL 本来就在范围外
  // （实测 1.1.23：一个字节都没截掉，末字节是 \n）。这个循环是给「未来布局把填充 NUL 划进
  // bundle 范围」留的防线 —— esbuild 见到 \x00 会直接报 Unexpected "\x00"。
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
