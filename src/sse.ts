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
 *
 * The split is greedy: it consumes every complete `data:` line in the buffer
 * and does not understand any stream-termination marker. Callers are
 * therefore responsible for stopping consumption once they reach their own
 * terminator (here, `[DONE]`), discarding any payloads after it. The inlined
 * loop this replaces broke at that terminator, so behavioural equivalence
 * depends on the caller honouring that contract.
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
