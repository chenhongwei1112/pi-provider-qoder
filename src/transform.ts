import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { CacheControl } from "./prompt-cache.js";

/** OpenAI-style tool definition sent to the Qoder API. */
interface QoderTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

/** OpenAI-style tool call within an assistant message. */
interface QoderToolCall {
  id?: string;
  type: "function";
  index: number;
  function: { name?: string; arguments: string };
}

type QoderTextPart = { type: "text"; text: string; cache_control?: CacheControl };
type QoderImagePart = { type: "image_url"; image_url: { url: string } };
type QoderContent = string | Array<QoderTextPart | QoderImagePart>;

/**
 * The reasoning item that travels next to `reasoning_content`. Redacted
 * reasoning keeps its opaque payload in `encrypted_content`
 * (pretty.mjs:111981-111999).
 */
type QoderReasoningItem = {
  encrypted_content?: string;
  type: "reasoning";
  summary?: Array<{ text: string; type: "summary_text" }>;
};

/** OpenAI-style message sent to the Qoder API. Fields are in wire key order. */
interface QoderMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: QoderContent | null;
  contents?: Array<QoderTextPart | QoderImagePart>;
  reasoning_content?: string;
  reasoning_content_signature?: string;
  reasoning_item?: QoderReasoningItem;
  tool_calls?: QoderToolCall[];
  tool_call_id?: string;
}

/** The prompt cache breakpoint markPromptCacheBreakpoint() stamped on a block. */
function blockCacheControl(block: unknown): CacheControl | undefined {
  if (!block || typeof block !== "object" || !("cache_control" in block)) return undefined;
  const raw = block.cache_control;
  if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string") return undefined;
  // Narrowed to the marker shape above; forwarded verbatim like the API does.
  return raw as CacheControl;
}

/**
 * The `reasoning_item` for one assistant turn (pretty.mjs:111995-111999). pi
 * never carries the provider's own reasoning item, so a redacted turn always
 * comes out as a bare `encrypted_content` plus the summary of whatever plain
 * thinking the same turn produced.
 */
function reasoningItem(thinking: string, encrypted: string | undefined): QoderReasoningItem | undefined {
  const summary = thinking ? [{ text: thinking, type: "summary_text" as const }] : undefined;
  if (encrypted !== undefined) {
    const item: QoderReasoningItem = { encrypted_content: encrypted, type: "reasoning" };
    if (summary) item.summary = summary;
    return item;
  }
  if (!summary) return undefined;
  return { type: "reasoning", summary };
}

export function getContentText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

/** The image blocks of a message, in order. Empty when there are none. */
export function getContentImages(msg: Message): ImageContent[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function transformTools(tools: Tool[]): QoderTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function transformMessagesForQoder(messages: Message[]): QoderMessage[] {
  const normalizedMessages: QoderMessage[] = [];
  // Tool calls belonging to assistant messages that were dropped below. Their
  // results have to go too: an OpenAI-shaped `tool` message is only valid
  // directly after the assistant message carrying the matching tool_calls, and
  // upstreams reject the request outright ("tool must follow a message with
  // tool_calls"). Assistant messages always precede their results, so one pass
  // is enough.
  const droppedToolCallIDs = new Set<string>();

  for (const msg of messages) {
    // Skip error or aborted messages
    if (
      msg.role === "assistant" &&
      ((msg as AssistantMessage).stopReason === "error" || (msg as AssistantMessage).stopReason === "aborted")
    ) {
      const dropped = msg as AssistantMessage;
      if (Array.isArray(dropped.content)) {
        for (const block of dropped.content) {
          if (block.type === "toolCall") droppedToolCallIDs.add((block as ToolCall).id);
        }
      }
      continue;
    }

    if (msg.role === "toolResult" && droppedToolCallIDs.has((msg as ToolResultMessage).toolCallId)) {
      continue;
    }

    if (msg.role === "user") {
      let content: QoderContent = "";
      // `contents` is the block array the API reads (pretty.mjs:111924-111962).
      // `content` keeps the value this plugin has always sent: for image-free
      // multi-block content upstream joins the text blocks with "\n" while
      // getContentText() joins with "", a difference handled separately so this
      // change moves one thing at a time.
      let contents: Array<QoderTextPart | QoderImagePart> = [];
      if (typeof msg.content === "string") {
        content = msg.content;
        contents = [{ type: "text", text: msg.content }];
      } else if (Array.isArray(msg.content)) {
        const parts = msg.content
          .map((c): QoderTextPart | QoderImagePart | null => {
            if (c.type === "text") {
              const part: QoderTextPart = { type: "text", text: (c as TextContent).text };
              // Text blocks carry a cache breakpoint through verbatim
              // (pretty.mjs:111938-111939).
              const cacheControl = blockCacheControl(c);
              if (cacheControl) part.cache_control = cacheControl;
              return part;
            }
            if (c.type === "image") {
              const img = c as ImageContent;
              return {
                type: "image_url",
                image_url: {
                  url: `data:${img.mimeType};base64,${img.data}`,
                },
              };
            }
            return null;
          })
          .filter((p): p is QoderTextPart | QoderImagePart => p !== null);
        contents = parts;
        content = msg.content.some((c) => c.type === "image") ? parts : getContentText(msg);
      }
      normalizedMessages.push({
        role: "user",
        content,
        contents,
      });
    } else if (msg.role === "assistant") {
      const am = msg as AssistantMessage;
      const textParts: QoderTextPart[] = [];
      const toolCalls: QoderToolCall[] = [];
      let reasoningText = "";
      let reasoningSignature: string | undefined;
      let encryptedReasoning: string | undefined;

      if (Array.isArray(am.content)) {
        for (const block of am.content) {
          if (block.type === "text") {
            // Empty text blocks are dropped, so they never create a `contents`
            // entry (pretty.mjs:111971).
            const text = (block as TextContent).text;
            if (!text) continue;
            const part: QoderTextPart = { type: "text", text };
            const cacheControl = blockCacheControl(block);
            if (cacheControl) part.cache_control = cacheControl;
            textParts.push(part);
          } else if (block.type === "thinking") {
            const th = block as ThinkingContent;
            // A redacted block is the API's `redacted_thinking`: no readable
            // text, only the opaque payload, which pi stores in
            // `thinkingSignature` (pretty.mjs:111981-111987).
            if (th.redacted) {
              if (th.thinkingSignature) encryptedReasoning = th.thinkingSignature;
              continue;
            }
            // Reasoning rides in its own fields and never inside `content`
            // (pretty.mjs:111977-111980, pretty.mjs:112002-112003).
            reasoningText += th.thinking;
            if (th.thinkingSignature) reasoningSignature = th.thinkingSignature;
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            toolCalls.push({
              id: tc.id,
              type: "function",
              // The calls of one turn are numbered from 0 (pretty.mjs:111990).
              index: toolCalls.length,
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
              },
            });
          }
        }
      } else if (typeof am.content === "string") {
        // Histories replayed from storage may carry a plain string here.
        const text: string = am.content;
        if (text) textParts.push({ type: "text", text });
      }

      // Text blocks concatenate with no separator (pretty.mjs:111893-111895
      // called from pretty.mjs:112000).
      const contentText = textParts.map((p) => p.text).join("");

      // Qoder's gateway drops assistant messages whose content is null, which
      // orphans the following tool_result and makes dmodel/ultimate upstreams
      // reject the request ("tool must follow a message with tool_calls").
      // When an assistant turn has tool calls but no text, inject a
      // single-space placeholder so the gateway keeps the message. The official
      // client has no such placeholder; this plugin hit the failure for real.
      // Reasoning no longer feeds `content`, so a reasoning-plus-tool-calls
      // turn lands here as well.
      const mapped: QoderMessage = {
        role: "assistant",
        content: contentText || (toolCalls.length > 0 ? " " : null),
      };
      if (textParts.length > 0) mapped.contents = textParts;
      if (reasoningText) mapped.reasoning_content = reasoningText;
      if (reasoningSignature) mapped.reasoning_content_signature = reasoningSignature;
      const item = reasoningItem(reasoningText, encryptedReasoning);
      if (item) mapped.reasoning_item = item;
      if (toolCalls.length > 0) mapped.tool_calls = toolCalls;
      normalizedMessages.push(mapped);
    } else if (msg.role === "toolResult") {
      const tr = msg as ToolResultMessage;
      normalizedMessages.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: getContentText(tr),
      });

      // A tool result may carry images — pi's `read` tool returns a text note
      // plus an `image` block for png/jpg/gif/webp/bmp, and screenshot tools do
      // the same. getContentText() maps every non-text block to "", so those
      // images were dropped silently: the TUI rendered the picture while the
      // model received only "Read image file [image/png]" and reported that it
      // could not see images.
      //
      // The OpenAI-shaped `tool` role has nowhere to put them — its content is
      // a plain string — so they follow as a separate user message, the same
      // shape the user branch above already builds. The leading label keeps the
      // model from reading a bare image as something the human just sent.
      const images = getContentImages(tr);
      if (images.length > 0) {
        normalizedMessages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[${images.length} image${images.length === 1 ? "" : "s"} returned by the previous tool call]`,
            },
            ...images.map(
              (img): QoderImagePart => ({
                type: "image_url",
                image_url: { url: `data:${img.mimeType};base64,${img.data}` },
              }),
            ),
          ],
        });
      }
    }
  }

  return normalizedMessages;
}
