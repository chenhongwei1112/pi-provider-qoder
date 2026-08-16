/**
 * 对真实 Qoder 网关跑一遍第二阶段第一批的验证（台账 docs/qoder-alignment-audit.md
 * 的「第二阶段第一批」一节）。用本机存的凭据，不改任何本地状态。
 *
 * 覆盖三条路径与全部 15 条改动：
 *   1. model/list   → auth 类头集（第 1、10、11、12 行）+ 响应解码（第 40 行）
 *   2. quota/usage  → 响应解码另一处（第 40 行）
 *   3. agent_chat_generation → infer 类头集与签名（第 2、3、4、5、6、7、13、50 行）
 *
 * 用法: npx tsx scripts/live-alignment-check.ts [模型]
 *
 * 只读：不写缓存、不动 auth.json。token 过期时会用 PAT 重新交换一次（这本身也顺带
 * 验证了第 49 行的 uid 别名改动），但拿到的新 token 只在本进程内用。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildAuthHeaders,
  getQoderChatURL,
  getQoderMode,
  getQoderModelListURL,
  getQoderUsageURL,
  ProviderUserAgent,
} from "../src/cosy.js";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildChatRequest } from "../src/request.js";
import { QoderEventTranslator } from "../src/events.js";
import { SSEFramer } from "../src/sse.js";
import { credentialsFromPat, isPatRefresh } from "../src/pat.js";
import { parseQoderJsonBody, qoderDecodeBody, qoderEncodeBodyToBuffer } from "../src/qoder-encoding.js";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const MODEL = process.argv[2] || "lite";
const mode = getQoderMode();

interface Creds {
  access: string;
  refresh?: string;
  expires?: number;
  userID: string;
  name?: string;
  email?: string;
  machineID?: string;
}

const results: { step: string; ok: boolean; detail: string }[] = [];
function record(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}\n      ${detail}`);
}

async function loadCreds(): Promise<Creds> {
  const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  const stored = (auth.qoder ?? auth["qoder-cn"]) as Creds | undefined;
  if (!stored?.access) throw new Error(`no qoder credentials in ${AUTH_FILE} — run the login flow first`);

  const expired = typeof stored.expires === "number" && stored.expires <= Date.now();
  if (!expired) return stored;

  if (!stored.refresh || !isPatRefresh(stored.refresh)) {
    throw new Error("stored token is expired and the refresh string is not a PAT — log in again, then re-run");
  }
  const pat = stored.refresh.split("|")[1];
  if (!pat) throw new Error("PAT refresh string has no token segment");

  const fresh = (await credentialsFromPat(pat, mode)) as unknown as Creds;
  record("token refresh (PAT re-exchange)", !!fresh.access && !!fresh.userID, `userID=${fresh.userID || "<empty>"}`);
  return fresh;
}

/** 打印插件实际发出的头名，方便和台账对照。 */
function headerNames(headers: Record<string, string>, merged: string[]): string {
  return [...new Set([...Object.keys(headers), ...merged])].sort().join(" ");
}

async function checkModelList(creds: Creds) {
  const url = getQoderModelListURL(mode);
  record("model/list URL carries /algo and Encode=1", url.includes("/algo/") && url.includes("Encode=1"), url);

  const headers = buildAuthHeaders(
    null,
    url,
    { userID: creds.userID, authToken: creds.access, name: creds.name || "", email: creds.email || "", machineID: creds.machineID },
    "auth",
  );
  console.log(`      auth 类头名: ${headerNames(headers, ["Content-Type", "Accept"])}`);

  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(20000),
  });
  const raw = await res.text();
  record(`model/list responded ${res.status}`, res.ok, res.ok ? `${raw.length} bytes` : raw.slice(0, 300));
  if (!res.ok) return;

  // 第 40 行：明文与编码两种正文都必须读得出来。
  let parsed: Record<string, unknown>;
  try {
    parsed = parseQoderJsonBody<Record<string, unknown>>(raw);
  } catch (e) {
    record("model/list body decoded", false, `parse failed: ${String(e)}`);
    return;
  }
  const wasEncoded = raw.trimStart()[0] !== "{" && raw.trimStart()[0] !== "[";
  const scenes = Object.keys(parsed);
  const assistant = (parsed.assistant ?? parsed.chat) as unknown[] | undefined;
  record(
    "model/list body decoded",
    Array.isArray(assistant) && assistant.length > 0,
    `${wasEncoded ? "服务端返回的是编码正文（解码路径生效）" : "服务端返回明文（解码为直通）"}；scenes=[${scenes.join(", ")}]；条目=${assistant?.length ?? 0}`,
  );
}

async function checkUsage(creds: Creds) {
  const res = await fetch(getQoderUsageURL(mode), {
    method: "GET",
    headers: { Authorization: `Bearer ${creds.access}`, Accept: "application/json", "User-Agent": ProviderUserAgent },
    signal: AbortSignal.timeout(20000),
  });
  const raw = await res.text();
  if (!res.ok) {
    record(`quota/usage responded ${res.status}`, false, raw.slice(0, 300));
    return;
  }
  try {
    const parsed = parseQoderJsonBody<Record<string, unknown>>(raw);
    record("quota/usage body decoded", true, `keys=[${Object.keys(parsed).join(", ")}]`);
  } catch (e) {
    record("quota/usage body decoded", false, `parse failed: ${String(e)}`);
  }
}

async function checkChat(creds: Creds) {
  const url = getQoderChatURL(mode);
  const body = {
    request_id: crypto.randomUUID(),
    request_set_id: crypto.randomUUID(),
    chat_record_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
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
    system: "",
    messages: [{ role: "user", content: "reply with the single word: ok" }],
    tools: [],
    parameters: { max_tokens: 64 },
    chat_context: { chatPrompt: "", imageUrls: null, extra: { context: [], modelConfig: { key: MODEL, is_reasoning: false }, originalContent: "reply with the single word: ok" }, features: [], text: "reply with the single word: ok" },
    model_config: { key: MODEL, display_name: MODEL, model: "", format: "openai", is_vl: false, is_reasoning: false, api_key: "", url: "", source: "system", max_input_tokens: 32000 },
  };

  const encoded = qoderEncodeBodyToBuffer(JSON.stringify(body));
  const headers = buildAuthHeaders(
    encoded,
    url,
    { userID: creds.userID, authToken: creds.access, name: creds.name || "", email: creds.email || "", machineID: creds.machineID },
    "infer",
  );
  const merged = ["Content-Type", "Accept", "Cache-Control", "Connection", "X-Model-Key", "X-Model-Source"];
  console.log(`      infer 类头名: ${headerNames(headers, merged)}`);
  record(
    "infer headers carry the business identity and no signature helpers",
    headers["Cosy-Business-Product"] === "cli" &&
      headers["Cosy-Scene"] === "assistant" &&
      headers["Cosy-Version"] === "1.1.23" &&
      headers["Cosy-Bodyhash"] === undefined &&
      headers["Cosy-Sigpath"] === undefined &&
      headers["Cosy-ClientIp"] === undefined,
    `Cosy-Version=${headers["Cosy-Version"]} MachineHostname=${headers["Cosy-MachineHostname"] ?? "<未发>"}`,
  );

  // 第 50 行：同一凭据两次调用必须回放同一个 Cosy-Key。
  const again = buildAuthHeaders(
    encoded,
    url,
    { userID: creds.userID, authToken: creds.access, name: creds.name || "", email: creds.email || "", machineID: creds.machineID },
    "infer",
  );
  record("Cosy-Key is replayed, not recomputed per request", again["Cosy-Key"] === headers["Cosy-Key"], "两次 buildAuthHeaders 的 Cosy-Key 相同");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Model-Key": MODEL,
      "X-Model-Source": "system",
      ...headers,
    },
    body: encoded,
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    record(`chat responded ${res.status}`, false, (await res.text().catch(() => "")).slice(0, 500));
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    record("chat stream readable", false, "no response body");
    return;
  }
  // 真实字节流同时喂两条路：① 原样留存，用于报告服务端是明文还是编码正文；
  // ② 走生产的 SSEFramer + QoderEventTranslator，这是面 3 解析改动唯一的真实数据验证
  //    —— 单元测试的 SSE 都是我手写的，只有这里的帧是服务端真发的。
  const output = {
    role: "assistant" as const,
    content: [] as AssistantMessage["content"],
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: undefined as AssistantMessage["stopReason"],
  } as unknown as AssistantMessage;
  const events: string[] = [];
  const eventStream = { push: (e: { type: string }) => events.push(e.type) } as unknown as AssistantMessageEventStream;
  const translator = new QoderEventTranslator(output, eventStream, { thinkingEnabled: false });
  const framer = new SSEFramer();

  const decoder = new TextDecoder();
  let seen = "";
  let chunks = 0;
  let frames = 0;
  let terminated = false;
  let parseError = "";
  // 上限要足够大到让流自己走到 [DONE]：推理型模型在吐出正文前可能先发很长的
  // reasoning_content，早早截断会让"未终止"看起来像解析 bug（第一次跑就是这样）。
  while (chunks < 600) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    seen += text;
    chunks += 1;
    if (!terminated && !parseError) {
      try {
        for (const frame of framer.push(text)) {
          frames += 1;
          if (translator.push(frame) === "done") {
            terminated = true;
            break;
          }
        }
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e);
      }
    }
    if (terminated || seen.length > 400000) break;
  }
  await reader.cancel().catch(() => {});
  record(`chat responded ${res.status} and streamed`, seen.length > 0, `${chunks} 个分片，${seen.length} 字符；首片: ${seen.slice(0, 120).replace(/\n/g, "\\n")}`);

  // 面 3 第 32/33/34 行：真实帧必须被事件块分帧器认出来，且不能抛。
  record(
    "production SSE framer + translator consume the real gateway stream",
    frames > 0 && !parseError,
    parseError ? `解析抛错：${parseError}` : `${frames} 个事件块，事件序列前若干：${events.slice(0, 6).join(" → ") || "<无>"}`,
  );

  // 面 3 第 35 行：真实流必须走到终止且落一个有效 stopReason，不能静默无终止。
  let stopReason = output.stopReason;
  if (!parseError) {
    try {
      stopReason = translator.finalize();
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
  }
  const text = output.content.find((c) => c.type === "text");
  record(
    "the real stream produces text and a valid stop reason",
    !parseError && (text ? "text" in text && text.text.length > 0 : false),
    parseError
      ? `finalize 抛错：${parseError}`
      : `stopReason=${stopReason ?? "<未设>"}，terminated=${terminated}，文本=${JSON.stringify(text && "text" in text ? text.text.slice(0, 60) : "")}`,
  );
}

/**
 * 第 4 步：用**生产的** `buildChatRequest` 造 body 打真实网关。
 *
 * 前三步的 chat 用的是手搓 body（照台账记录的官方形状），验的是头集与签名；面 2 改的是
 * `buildChatRequest` 本身 —— 顶层键序、`system` 取值、`parameters` 的 reasoning 通道、
 * `model_config` 的固定十键、`chat_context` 键序、消息里的 `contents`/`reasoning_content`/
 * `tool_calls.index`、prompt cache 断点。这些字节全部进签名载荷，键序错一位就可能 400/401，
 * 所以必须让真实网关判一次。
 */
async function checkProductionBody(creds: Creds) {
  const context = {
    messages: [{ role: "user", content: "reply with the single word: ok" }],
    systemPrompt: "You are a terse assistant.",
    tools: [],
  } as unknown as Parameters<typeof buildChatRequest>[0]["context"];

  const built = buildChatRequest({
    model: { id: MODEL } as unknown as Parameters<typeof buildChatRequest>[0]["model"],
    context,
    options: undefined,
    providerMode: mode,
    identity: { userID: creds.userID, machineID: creds.machineID } as unknown as Parameters<
      typeof buildChatRequest
    >[0]["identity"],
  });

  // 解码回明文，报告生产 body 的实际形状（键序是签名的一部分）。
  const decoded = JSON.parse(qoderDecodeBody(built.encodedBytes.toString("latin1")));
  console.log(`      生产 body 顶层键序: ${Object.keys(decoded).join(" ")}`);
  console.log(`      parameters: ${JSON.stringify(decoded.parameters)}`);
  console.log(`      model_config 键序: ${Object.keys(decoded.model_config).join(" ")}`);
  console.log(`      chat_context 键序: ${Object.keys(decoded.chat_context).join(" ")}`);

  record(
    "the production body carries the official top-level order and no invented keys",
    Object.keys(decoded).indexOf("chat_context") === 6 &&
      decoded.system === "You are a terse assistant." &&
      !("code_language" in decoded) &&
      !("chat_prompt" in decoded) &&
      !("image_urls" in decoded) &&
      !("thinking_config" in decoded.model_config),
    `system=${JSON.stringify(decoded.system)}，chat_context 在第 ${Object.keys(decoded).indexOf("chat_context") + 1} 位`,
  );

  const headers = buildAuthHeaders(
    built.encodedBytes,
    built.chatURL,
    {
      userID: creds.userID,
      authToken: creds.access,
      name: creds.name || "",
      email: creds.email || "",
      machineID: creds.machineID,
    },
    "infer",
  );

  const res = await fetch(built.chatURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Model-Key": built.qoderModel,
      "X-Model-Source": built.modelSource,
      ...headers,
    },
    body: built.encodedBytes,
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    record("the gateway accepts the production body", false, `${res.status} ${(await res.text().catch(() => "")).slice(0, 500)}`);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    record("the gateway accepts the production body", false, "no response body");
    return;
  }
  const output = {
    role: "assistant" as const,
    content: [] as AssistantMessage["content"],
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: undefined as AssistantMessage["stopReason"],
  } as unknown as AssistantMessage;
  const eventStream = { push: () => {} } as unknown as AssistantMessageEventStream;
  const translator = new QoderEventTranslator(output, eventStream, { thinkingEnabled: false });
  const framer = new SSEFramer();
  const decoder = new TextDecoder();
  let terminated = false;
  let chunks = 0;
  while (chunks < 600) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    for (const frame of framer.push(decoder.decode(value, { stream: true }))) {
      if (translator.push(frame) === "done") {
        terminated = true;
        break;
      }
    }
    if (terminated) break;
  }
  await reader.cancel().catch(() => {});
  const stop = terminated ? translator.finalize() : undefined;
  const text = output.content.find((c) => c.type === "text");
  record(
    "the gateway accepts the production body",
    res.status === 200 && terminated && !!text,
    `${res.status}，${chunks} 个分片，stopReason=${stop ?? "<未终止>"}，文本=${JSON.stringify(text && "text" in text ? text.text.slice(0, 40) : "")}`,
  );
}

async function main() {
  console.log(`mode=${mode} model=${MODEL}\n`);
  const creds = await loadCreds();

  await checkModelList(creds);
  await checkUsage(creds);
  await checkChat(creds);
  await checkProductionBody(creds);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"─".repeat(60)}`);
  if (failed.length === 0) {
    console.log(`全部 ${results.length} 项通过。第二阶段的改动（身份链 18 条 + 面 3 解析 6 条）在真实网关上没有回归。`);
    return;
  }
  console.log(`${failed.length}/${results.length} 项失败：`);
  for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
  console.log("\n若是 401/403，按台账「第二阶段第一批」一节的嫌疑排序回滚定位：第 2 → 7 → 9 → 10/11 行。");
  process.exitCode = 1;
}

await main();
