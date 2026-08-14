import { buildAuthHeaders } from "./cosy.js";

/**
 * Transport budget, mirroring the `infer-sse` contract in Qoder's own CLI:
 * 3 attempts, and a 60s ceiling on the first payload. The idle ceiling matches
 * its default `stream_idle_timeout_ms`.
 */
const MAX_SEND_ATTEMPTS = 3;
const FIRST_PAYLOAD_TIMEOUT_MS = 60_000;
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * Connection-level faults Qoder's CLI retries. `fetch failed` is undici's
 * opaque wrapper: it is what a request gets when the pooled keep-alive socket
 * was closed by the gateway before the write, which happens routinely once a
 * turn spends longer in tool calls than undici's 4s keep-alive window.
 */
const RETRYABLE_ERROR_CODES: Record<string, true> = {
  UND_ERR_SOCKET: true,
  ECONNRESET: true,
  EPIPE: true,
  ETIMEDOUT: true,
  ECONNREFUSED: true,
  EAI_AGAIN: true,
  ENOTFOUND: true,
  EPROTO: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
};

/** Retryable HTTP statuses: transient gateway faults and rate limits. */
const RETRYABLE_STATUSES: Record<number, true> = {
  408: true,
  425: true,
  429: true,
  500: true,
  502: true,
  503: true,
  504: true,
};

/**
 * `Retry-After`, in ms. Accepts both forms RFC 9110 allows: delay-seconds and
 * an HTTP-date. Returns undefined when the header is absent or unparseable.
 */
function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Error messages undici raises for a connection that died under us. */
const RETRYABLE_ERROR_MESSAGES: Record<string, true> = {
  "fetch failed": true,
  "other side closed": true,
  "socket hang up": true,
  terminated: true,
};

interface ErrorLink {
  name?: string;
  code?: string;
  message: string;
}

/** The error chain as `{ name, code, message }` triples, outermost first. */
function errorChain(error: unknown): ErrorLink[] {
  const chain: ErrorLink[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const link: ErrorLink = { message: "" };
    if ("name" in current && typeof current.name === "string") link.name = current.name;
    if ("code" in current && typeof current.code === "string") link.code = current.code;
    if ("message" in current) link.message = typeof current.message === "string" ? current.message : "";
    chain.push(link);
    current = "cause" in current ? current.cause : undefined;
  }
  if (chain.length === 0) chain.push({ message: String(error) });
  return chain;
}

function isRetryableTransportError(error: unknown): boolean {
  return errorChain(error).some(
    (link) =>
      (link.code !== undefined && RETRYABLE_ERROR_CODES[link.code] === true) ||
      link.name === "ConnectTimeoutError" ||
      RETRYABLE_ERROR_MESSAGES[link.message] === true,
  );
}

/**
 * Flatten the cause chain into the message. `fetch failed` on its own says
 * nothing; the `cause` carries the actual syscall or undici code.
 */
function formatTransportError(error: unknown): Error {
  const chain = errorChain(error);
  const detail = chain
    .slice(1)
    .map((link) => `${link.name ?? "Error"}${link.code ? `(${link.code})` : ""}: ${link.message}`)
    .join(" <- ");
  const head = chain[0]?.message ?? String(error);
  const formatted = new Error(detail ? `${head} (${detail})` : head);
  formatted.cause = error;
  return formatted;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Executor form: `Promise.withResolvers` needs ES2024/Node 22, and this
  // extension still has to load on the Node 20 baseline pi supports.
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface OpenStreamRequest {
  chatURL: string;
  encodedBytes: Buffer<ArrayBuffer>;
  qoderModel: string;
  modelSource: string;
  callerSignal?: AbortSignal;
  creds: { userID: string; authToken: string; name: string; email: string; machineID: string };
}

export interface OpenedQoderStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** First chunk, already consumed from the reader to prove the stream is live. */
  firstChunk: Uint8Array;
  armIdleWatchdog: () => void;
  disarmWatchdog: () => void;
  /** Turn a mid-stream read failure into a message that names the real cause. */
  describeStreamError: (error: unknown) => Error;
}

/**
 * POST the chat request and return the stream once its first byte has arrived.
 *
 * Everything that can fail before that first byte — connect, TLS, request
 * write, response headers, first payload — is retried with exponential backoff,
 * because none of it can have produced model output yet. `request_id` is reused
 * across attempts so the gateway can recognise a retry of the same turn.
 */
export async function openQoderStream(request: OpenStreamRequest): Promise<OpenedQoderStream> {
  const { chatURL, encodedBytes, qoderModel, modelSource, callerSignal, creds } = request;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? new Error("Aborted");

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    let timedOutAfterMs: number | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOutAfterMs = ms;
        controller.abort();
      }, ms);
      watchdog.unref?.();
    };
    const disarmWatchdog = () => {
      clearTimeout(watchdog);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const describeStreamError = (error: unknown): Error => {
      if (timedOutAfterMs !== undefined) {
        return new Error(`Qoder stream stalled: no data for ${Math.round(timedOutAfterMs / 1000)}s`);
      }
      if (callerSignal?.aborted) return error instanceof Error ? error : new Error(String(error));
      return formatTransportError(error);
    };

    // The clock starts at the request, not at the response headers: a stalled
    // gateway must not hold the turn open forever.
    arm(FIRST_PAYLOAD_TIMEOUT_MS);

    try {
      // Rebuilt per attempt: the COSY signature covers a timestamp.
      const headers = buildAuthHeaders(encodedBytes, chatURL, creds);
      const response = await fetch(chatURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Accept-Encoding": "identity",
          "X-Model-Key": qoderModel,
          "X-Model-Source": modelSource,
          ...headers,
        },
        body: encodedBytes,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw Object.assign(
          new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`),
          { status: response.status, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) },
        );
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const first = await reader.read();
      if (first.done) throw new Error("Qoder stream closed before sending any data");
      arm(STREAM_IDLE_TIMEOUT_MS);

      return {
        reader,
        firstChunk: first.value,
        armIdleWatchdog: () => arm(STREAM_IDLE_TIMEOUT_MS),
        disarmWatchdog,
        describeStreamError,
      };
    } catch (e) {
      disarmWatchdog();
      if (callerSignal?.aborted) throw e;

      const status = e && typeof e === "object" && "status" in e && typeof e.status === "number" ? e.status : undefined;
      const retryable =
        timedOutAfterMs !== undefined ||
        (status !== undefined ? RETRYABLE_STATUSES[status] === true : isRetryableTransportError(e));
      lastError = timedOutAfterMs !== undefined ? describeStreamError(e) : e;
      if (!retryable || attempt === MAX_SEND_ATTEMPTS) break;

      // A server that sent `Retry-After` has told us exactly how long to wait;
      // exponential backoff would only guess, and on 429 the guess (500ms) is
      // short enough that retrying just triples the load that got us throttled.
      // Waiting longer than the ceiling is worse than failing: pi can surface a
      // rate-limit error and let the user decide.
      const retryAfterMs =
        e && typeof e === "object" && "retryAfterMs" in e && typeof e.retryAfterMs === "number"
          ? e.retryAfterMs
          : undefined;
      if (retryAfterMs !== undefined && retryAfterMs > RETRY_MAX_DELAY_MS) break;

      let waitMs: number;
      if (retryAfterMs !== undefined) {
        waitMs = retryAfterMs;
      } else {
        const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        waitMs = Math.max(0, delay + delay * 0.3 * (Math.random() * 2 - 1));
      }
      if (process.env.QODER_DEBUG) {
        console.error(
          `[pi-provider-qoder] attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed (${
            lastError instanceof Error ? lastError.message : String(lastError)
          }); retrying in ${Math.round(waitMs)}ms`,
        );
      }
      await sleep(waitMs, callerSignal);
    }
  }

  throw formatTransportError(lastError);
}
