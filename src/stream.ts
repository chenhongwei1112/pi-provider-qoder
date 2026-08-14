import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";
import { getQoderMode, isQoderCNMode } from "./cosy.js";
import { QoderEventTranslator } from "./events.js";
import { resolveQoderSigningIdentity } from "./oauth.js";
import { buildChatRequest } from "./request.js";
import { splitSSEData } from "./sse.js";
import { type OpenedQoderStream, openQoderStream } from "./transport.js";

export function streamQoder(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  (async () => {
    // Declared out here so the watchdog is torn down even when the stream ends
    // through a throw: a live timer would abort a fetch nobody is reading.
    let opened: OpenedQoderStream | undefined;
    try {
      const providerMode = model.provider === "qoder-cn" ? "cn" : getQoderMode();
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error(
          isQoderCNMode(providerMode)
            ? "Qoder CN credentials not set. Run /login qoder-cn or set QODERCN_PERSONAL_ACCESS_TOKEN."
            : "Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.",
        );
      }

      // Resolve user details from cached credentials. The signing variant: this
      // is the one path that actually signs a request, so it needs machineID.
      const identity = resolveQoderSigningIdentity(model.provider, providerMode);

      const request = buildChatRequest({ model, context, options, providerMode, identity });

      opened = await openQoderStream({
        ...request,
        callerSignal: options?.signal,
        creds: { ...identity, authToken: accessToken },
      });
      const { reader, armIdleWatchdog, describeStreamError } = opened;
      let pendingChunk: Uint8Array | undefined = opened.firstChunk;

      const decoder = new TextDecoder();
      const thinkingEnabled = (options?.reasoning as unknown) !== false && (options?.reasoning as unknown) !== "off";
      const translator = new QoderEventTranslator(output, stream, { thinkingEnabled });

      stream.push({ type: "start", partial: output });

      let buffer = "";
      // Set when the terminator arrives, so the outer read loop stops instead of
      // waiting for the server to close the socket.
      let finished = false;

      while (!finished) {
        let chunk: Uint8Array;
        if (pendingChunk) {
          chunk = pendingChunk;
          pendingChunk = undefined;
        } else {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (e) {
            throw describeStreamError(e);
          }
          if (result.done) break;
          chunk = result.value;
          armIdleWatchdog();
        }

        buffer += decoder.decode(chunk, { stream: true });
        const { payloads, rest } = splitSSEData(buffer);
        buffer = rest;

        // splitSSEData is greedy and knows no terminator, so stop consuming at
        // the first "done": anything the server sent after it is discarded,
        // which is what the inlined loop's break did.
        for (const payload of payloads) {
          if (translator.push(payload) === "done") {
            finished = true;
            break;
          }
        }
      }

      stream.push({ type: "done", reason: translator.finalize(), message: output });
      stream.end();
    } catch (e: unknown) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = e instanceof Error ? e.message : String(e);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    } finally {
      opened?.disarmWatchdog();
    }
  })();

  return stream;
}
