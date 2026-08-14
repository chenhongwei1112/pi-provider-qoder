import crypto from "node:crypto";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getQoderChatURL, getQoderCNDirectModel, isQoderCNMode, type QoderIdentity } from "./cosy.js";
import { getCachedModelConfig } from "./models.js";
import { qoderEncodeBodyToBuffer } from "./qoder-encoding.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";

/** First 16 hex chars of sha256 over a domain prefix plus NUL-separated parts. */
export function stableID(prefix: string, parts: Iterable<string>): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Stable id for one chat turn, wire-visible as `request_set_id`/`chat_record_id`.
 *
 * The parts are collected in the exact order the id has always hashed them, so
 * the hex stays byte-identical: model, then each message's role and content
 * (each skipped when falsy), then the tools JSON whenever `tools` is truthy at
 * all — an empty array included — then the token cap.
 */
export function chatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const parts: string[] = [model];
  for (const msg of messages) {
    if (msg?.role) parts.push(msg.role);
    if (msg?.content) parts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
  }
  if (tools) parts.push(JSON.stringify(tools));
  parts.push(`mt=${maxTokens}`);
  return stableID("qoder-record", parts);
}

export interface QoderChatRequest {
  encodedBytes: Buffer<ArrayBuffer>;
  qoderModel: string;
  modelSource: string;
  chatURL: string;
}

/**
 * Build the chat request body and everything the transport needs to send it.
 *
 * Pure with respect to the network: it reads the model cache and hashes the
 * conversation, but performs no I/O beyond that cache read.
 */
export function buildChatRequest(args: {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  providerMode: string;
  identity: QoderIdentity;
}): QoderChatRequest {
  const { model, context, options, providerMode, identity } = args;

  const qoderModel = isQoderCNMode(providerMode) ? getQoderCNDirectModel(model.id) : model.id;
  const modelConfig = getCachedModelConfig(qoderModel, providerMode) || {
    key: qoderModel,
    is_reasoning:
      qoderModel === "ultimate" ||
      qoderModel === "performance" ||
      qoderModel.includes("dmodel") ||
      qoderModel.includes("dfmodel"),
    max_output_tokens: 32768,
    source: "system",
  };
  modelConfig.key = qoderModel;

  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = modelConfig.max_output_tokens || 32768;

  const normalizedMessages = transformMessagesForQoder(context.messages);
  const systemText = context.systemPrompt || "";

  let lastUserText = "";
  for (let i = normalizedMessages.length - 1; i >= 0; i--) {
    if (normalizedMessages[i].role === "user") {
      const content = normalizedMessages[i].content;
      lastUserText =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c) => ("text" in c ? c.text : "")).join("")
            : "";
      break;
    }
  }

  // Use a stable session id when pi provides one (per agent session) so
  // the Qoder server can maintain prompt cache affinity across consecutive
  // requests. Fall back to a random id only when no sessionId is available.
  const stablePart = stableID("qoder-session", [identity.userID, qoderModel]);
  const sessionID = options?.sessionId ? `${stablePart}-${options.sessionId}` : `${stablePart}-${crypto.randomUUID()}`;

  // maxOutputTokens is `modelConfig.max_output_tokens || 32768`, so it is always
  // positive; the old `if (maxOutputTokens > 0)` guard could never fail.
  let maxTokens = maxOutputTokens;
  if (options?.maxTokens && options.maxTokens < maxTokens) {
    maxTokens = options.maxTokens;
  }

  const toolsRaw = context.tools && context.tools.length > 0 ? transformTools(context.tools) : undefined;
  const recordID = chatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

  const reqBody: Record<string, unknown> = {
    request_id: crypto.randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: sessionID,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    // Qoder's server ignores the top-level `system` field (verified: the
    // model never sees it). Inject the system prompt as a leading
    // role:system message instead, which the server does honor.
    system: "",
    messages: systemText ? [{ role: "system", content: systemText }, ...normalizedMessages] : normalizedMessages,
    tools: toolsRaw || [],
    parameters: { max_tokens: maxTokens },
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: {
          key: qoderModel,
          is_reasoning: isReasoning,
        },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: modelConfig,
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: crypto.randomUUID(),
      name: lastUserText.substring(0, 30),
      begin_at: Date.now(),
    },
  };

  const bodyBytes = Buffer.from(JSON.stringify(reqBody));
  const encodedBytes = qoderEncodeBodyToBuffer(bodyBytes);

  const chatURL = getQoderChatURL(providerMode);
  const modelSource = modelConfig.source || "system";

  return { encodedBytes, qoderModel, modelSource, chatURL };
}
