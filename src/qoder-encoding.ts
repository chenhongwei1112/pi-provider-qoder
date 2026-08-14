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
