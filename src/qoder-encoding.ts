const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Byte-level substitution table: standard base64 alphabet → Qoder's alphabet,
 * `=` → `$`, everything else identity.
 *
 * A table lookup replaces the per-character `qoderStdAlphabet.indexOf(c)` scan
 * the naive implementation used. On a 460 KB request body that scan ran ~600k
 * times over a 64-char string (~38M character comparisons) while `out += c`
 * built a 600k-deep rope, and the resulting garbage kept V8 in a mark-compact
 * loop: one call burned ~100s of CPU with the event loop fully stalled. That
 * stall also broke the next request — undici's keep-alive timer could not run,
 * so the pooled socket was dead by the time the encode finished.
 */
const substitution = (() => {
  const table = Buffer.allocUnsafe(256);
  for (let byte = 0; byte < 256; byte++) table[byte] = byte;
  for (let i = 0; i < qoderStdAlphabet.length; i++) {
    table[qoderStdAlphabet.charCodeAt(i)] = qoderCustomAlphabet.charCodeAt(i);
  }
  table[0x3d /* = */] = 0x24 /* $ */;
  return table;
})();

/**
 * Qoder's request-body obfuscation: base64, rotate the string by thirds, then
 * substitute the alphabet. Output is pure ASCII, so the Buffer and string forms
 * are byte-identical.
 */
export function qoderEncodeBodyToBuffer(plaintext: string | Uint8Array): Buffer<ArrayBuffer> {
  const source =
    typeof plaintext === "string"
      ? Buffer.from(plaintext)
      : Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const base64 = source.toString("base64");
  const n = base64.length;
  const out = Buffer.allocUnsafe(n);
  if (n === 0) return out;

  // `latin1` keeps one byte per base64 character (all ASCII).
  const src = Buffer.from(base64, "latin1");
  const a = Math.floor(n / 3);

  // rearranged = src[n-a, n) + src[a, n-a) + src[0, a)
  let w = 0;
  for (let i = n - a; i < n; i++) out[w++] = substitution[src[i]];
  for (let i = a; i < n - a; i++) out[w++] = substitution[src[i]];
  for (let i = 0; i < a; i++) out[w++] = substitution[src[i]];
  return out;
}

export function qoderEncodeBody(plaintext: string | Uint8Array): string {
  return qoderEncodeBodyToBuffer(plaintext).toString("latin1");
}

/** 反向替换表：Qoder 字母表 → 标准 base64，`$` → `=`，其余恒等。 */
const inverseSubstitution = (() => {
  const table = Buffer.allocUnsafe(256);
  for (let byte = 0; byte < 256; byte++) table[byte] = byte;
  for (let i = 0; i < qoderCustomAlphabet.length; i++) {
    table[qoderCustomAlphabet.charCodeAt(i)] = qoderStdAlphabet.charCodeAt(i);
  }
  table[0x24 /* $ */] = 0x3d /* = */;
  return table;
})();

/**
 * `qoderEncodeBody` 的逆运算。官方对所有非流式 JSON 响应都过一遍
 * `decrypt_server_response`（台账差异第 40 行），本函数是它的 TS 侧对应物。
 *
 * 旋转那一步是对合：编码把首尾各 `a = floor(n/3)` 个字符互换、中段不动，
 * 所以解码用同一个互换即可，不需要反向公式。
 */
export function qoderDecodeBody(encoded: string): string {
  const n = encoded.length;
  if (n === 0) return "";

  const src = Buffer.from(encoded, "latin1");
  const restored = Buffer.allocUnsafe(n);
  const a = Math.floor(n / 3);

  let w = 0;
  for (let i = n - a; i < n; i++) restored[w++] = inverseSubstitution[src[i]];
  for (let i = a; i < n - a; i++) restored[w++] = inverseSubstitution[src[i]];
  for (let i = 0; i < a; i++) restored[w++] = inverseSubstitution[src[i]];

  return Buffer.from(restored.toString("latin1"), "base64").toString("utf8");
}

/**
 * 读官方可能编码过的 JSON 响应体。官方的封装（`pretty.mjs:1028-1038`）是
 * 「WASM 抛异常就原样返回入参，再 JSON.parse」，实测 WASM 对明文恒等；这里
 * 用等价的可观测行为：明文能直接 parse 就直接用，否则先解码再 parse。
 *
 * 今天服务端对本插件返回的是明文，所以这条路径等于无操作；它存在是为了服务端
 * 哪天改成编码返回时不会变成满屏乱码。
 */
export function parseQoderJsonBody<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    return JSON.parse(qoderDecodeBody(body)) as T;
  }
}
