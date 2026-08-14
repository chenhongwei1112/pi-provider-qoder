import crypto from "node:crypto";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getQoderChatURL, getQoderCNDirectModel, isQoderCNMode } from "./cosy.js";
import { getCachedModelConfig } from "./models.js";
import { qoderEncodeBodyToBuffer } from "./qoder-encoding.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update("\0");
  hash.update(model);
  for (const msg of messages) {
    if (msg?.role) {
      hash.update("\0");
      hash.update(msg.role);
    }
    if (msg?.content) {
      hash.update("\0");
      hash.update(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    }
  }
  if (tools) {
    hash.update("\0");
    hash.update(JSON.stringify(tools));
  }
  hash.update("\0");
  hash.update(`mt=${maxTokens}`);
  return hash.digest("hex").slice(0, 16);
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
  identity: { userID: string; name: string; email: string; machineID: string };
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
  const stablePart = stableHash("qoder-session", identity.userID, qoderModel);
  const sessionID = options?.sessionId ? `${stablePart}-${options.sessionId}` : `${stablePart}-${crypto.randomUUID()}`;

  let maxTokens = 32768;
  if (maxOutputTokens > 0) {
    maxTokens = maxOutputTokens;
  }
  if (options?.maxTokens && options.maxTokens < maxTokens) {
    maxTokens = options.maxTokens;
  }

  const toolsRaw = context.tools && context.tools.length > 0 ? transformTools(context.tools) : undefined;
  const recordID = stableChatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

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
