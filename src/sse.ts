/**
 * Default per-line byte ceiling: 16 MiB, the official `maxLineBytes`
 * (`pretty.mjs:68707`, checked at `pretty.mjs:132591`).
 */
export const MAX_SSE_LINE_BYTES = 16777216;

/**
 * Default per-event `data` byte ceiling: 32 MiB, the official `maxEventBytes`
 * (`pretty.mjs:68707`, checked at `pretty.mjs:132694`).
 */
export const MAX_SSE_EVENT_BYTES = 33554432;

/**
 * A protocol ceiling was crossed, so the stream is unusable rather than merely
 * odd. Mirrors the official `RangeError` subclass (`pretty.mjs:68709-68713`)
 * down to the `protocol_limit` code, because a caller distinguishing "server
 * is flooding us" from "server sent garbage" needs the same signal.
 */
export class SSEProtocolLimitError extends RangeError {
  readonly code = "protocol_limit";
  constructor(
    readonly limitKind: "line" | "event",
    readonly limitBytes: number,
    readonly actualBytes: number,
  ) {
    super(`SSE ${limitKind} exceeds ${limitBytes} bytes (got ${actualBytes})`);
    this.name = "SSEProtocolLimitError";
  }
}

/** One SSE event block. */
export interface SSEFrame {
  /** Every `data:` value of the block joined with `\n`. Not trimmed. */
  data: string;
  /** The `event:` field, absent when the block did not carry one. */
  event?: string;
  /** The `id:` field, absent when the block did not carry one. */
  id?: string;
}

/**
 * Stateful, cross-chunk SSE framer.
 *
 * Framing only — this class knows nothing about Qoder. It delivers whole event
 * blocks, which is the unit the wire protocol actually defines and the unit the
 * translator needs: `event:` decides whether a non-200 envelope is an error at
 * all, so a `data:`-only splitter could not express that rule.
 *
 * Line and field handling follow the official reader (`pretty.mjs:132668-132708`):
 * split on `\n`; strip exactly one trailing `\r` per line; a blank line ends the
 * block; `:`-prefixed lines are comments; lines with no colon are skipped
 * outright rather than read as a valueless field; the field name is everything
 * before the first colon and the value everything after it with at most one
 * leading space removed. Values are never trimmed, so a payload's own trailing
 * whitespace survives to `JSON.parse`.
 *
 * The framer knows no stream terminator. Callers stay responsible for stopping
 * at their own (here, `[DONE]`) and discarding whatever follows it.
 */
export class SSEFramer {
  /** Incomplete final line of the previous chunk, waiting for its newline. */
  private pending = "";
  /** UTF-8 byte length of `pending`, tracked so a huge line is caught early. */
  private pendingBytes = 0;
  /** `data:` values of the block being accumulated. */
  private data: string[] = [];
  /** UTF-8 byte length `data` will occupy once joined, including separators. */
  private dataBytes = 0;
  private event: string | undefined;
  private id: string | undefined;

  /** Feed one decoded chunk; returns the blocks it completed, if any. */
  push(chunk: string): SSEFrame[] {
    const parts = chunk.split("\n");

    // No newline anywhere: the whole chunk extends the pending line. Charging
    // it against the line ceiling here is what stops an endless header-less
    // body from being buffered without bound.
    if (parts.length === 1) {
      this.pending += chunk;
      this.pendingBytes += Buffer.byteLength(chunk, "utf8");
      this.checkLine(this.pendingBytes);
      return [];
    }

    // The first piece completes `pending`; the last is the new `pending`. Byte
    // lengths are computed per piece and summed rather than measured on the
    // concatenation, so the pending line is never re-encoded chunk after chunk.
    const first = parts.shift() ?? "";
    const tail = parts.pop() ?? "";
    const lines: Array<{ value: string; byteLength: number }> = [
      { value: this.pending + first, byteLength: this.pendingBytes + Buffer.byteLength(first, "utf8") },
    ];
    for (const part of parts) {
      lines.push({ value: part, byteLength: Buffer.byteLength(part, "utf8") });
    }

    this.pending = tail;
    this.pendingBytes = Buffer.byteLength(tail, "utf8");
    this.checkLine(this.pendingBytes);

    const frames: SSEFrame[] = [];
    for (const line of lines) {
      this.checkLine(line.byteLength);
      const frame = this.consumeLine(line.value);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Handle one complete line; returns a frame when the line closed a block. */
  private consumeLine(raw: string): SSEFrame | undefined {
    const line = raw.replace(/\r$/, "");

    if (line === "") {
      // Blank line: deliver, but only if the block carries something. A stream
      // of bare newlines is a heartbeat, not a run of empty events
      // (`pretty.mjs:132679-132685`). Truthiness, not `!== undefined`, matches
      // the official test: `event:` with an empty value does not make a frame.
      const frame = this.data.length > 0 || this.event || this.id ? this.buildFrame() : undefined;
      this.reset();
      return frame;
    }

    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    if (colon === -1) return undefined;

    const name = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (name) {
      case "data": {
        // The `\n` that will join this value to the previous one counts too,
        // so the ceiling matches the delivered `data` string exactly.
        this.dataBytes += Buffer.byteLength(value, "utf8") + (this.data.length > 0 ? 1 : 0);
        if (this.dataBytes > MAX_SSE_EVENT_BYTES) {
          throw new SSEProtocolLimitError("event", MAX_SSE_EVENT_BYTES, this.dataBytes);
        }
        this.data.push(value);
        break;
      }
      case "event":
        this.event = value;
        break;
      case "id":
        this.id = value;
        break;
      // `retry:` is flow control we do not implement, and unknown fields are
      // ignored by the spec. Both are dropped without ending the block.
      default:
        break;
    }
    return undefined;
  }

  private buildFrame(): SSEFrame {
    const frame: SSEFrame = { data: this.data.join("\n") };
    if (this.event !== undefined) frame.event = this.event;
    if (this.id !== undefined) frame.id = this.id;
    return frame;
  }

  private reset(): void {
    this.data = [];
    this.dataBytes = 0;
    this.event = undefined;
    this.id = undefined;
  }

  private checkLine(byteLength: number): void {
    if (byteLength > MAX_SSE_LINE_BYTES) {
      throw new SSEProtocolLimitError("line", MAX_SSE_LINE_BYTES, byteLength);
    }
  }
}
