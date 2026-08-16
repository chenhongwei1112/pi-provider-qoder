import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildAuthHeaders,
  getQoderBaseUrl,
  getQoderCNFriendlyModelInfo,
  getQoderMode,
  getQoderModelListURL,
  isQoderCNMode,
} from "./cosy.js";
import { type QoderModelDef, staticCnModels, staticModels, ZERO_COST } from "./models-static.js";
import { agentPath } from "./paths.js";
import { parseQoderJsonBody } from "./qoder-encoding.js";

/** Shape of a single entry returned by the Qoder /model/list endpoint. */
interface QoderModelEntry {
  key?: string;
  enable?: boolean | 0;
  display_name?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  context_config?: Record<string, { token_count?: number; is_default?: boolean }>;
  is_vl?: boolean;
  is_reasoning?: boolean;
  thinking_config?: { enabled?: { efforts?: unknown } };
  source?: string;
  [key: string]: unknown;
}

function getQoderCachePath(mode?: string): string {
  return agentPath(isQoderCNMode(mode) ? "qoder-cn-models-cache.json" : "qoder-models-cache.json");
}

export function getCachedModels(mode?: string): QoderModelDef[] {
  const cachePath = getQoderCachePath(mode);
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf8"));
      if (data && Array.isArray(data.models)) {
        // Older releases injected `auto` without a corresponding service config.
        // Keep an explicitly enabled service model, but drop the legacy fallback.
        if (data.configs && typeof data.configs === "object" && !data.configs.auto) {
          return data.models.filter((model: QoderModelDef) => model.id !== "auto");
        }
        return data.models;
      }
    } catch {}
  }
  return isQoderCNMode(mode) ? staticCnModels : staticModels;
}

export function getCachedModelConfig(modelKey: string, mode?: string): QoderModelEntry | null {
  const cachePath = getQoderCachePath(mode);
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf8"));
      if (data?.configs?.[modelKey]) {
        return withMaxContextAsDefault(data.configs[modelKey] as QoderModelEntry);
      }
    } catch {}
  }

  if (isQoderCNMode(mode)) {
    const reasoningModels = new Set([
      "qoder-cn",
      "auto",
      "qmodel_latest",
      "qmodel",
      "q36fmodel",
      "qfmodel",
      "dmodel",
      "gm51model",
      "kmodel",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.6-flash",
      "deepseek-v4-pro",
      "glm-5.2",
      "glm-5.1",
      "kimi-k2.6",
    ]);
    return {
      key: modelKey,
      is_reasoning: reasoningModels.has(modelKey),
      max_output_tokens: 32768,
      source: "system",
    };
  }
  // Global mode fallback: check static model definitions for reasoning flag
  const staticEntry = staticModels.find((m) => m.id === modelKey);
  if (staticEntry) {
    return {
      key: modelKey,
      is_reasoning: staticEntry.reasoning,
      max_output_tokens: staticEntry.maxTokens,
      source: "system",
    };
  }

  return null;
}

/** Prefer the largest context option when Qoder exposes selectable contexts. */
function withMaxContextAsDefault(entry: QoderModelEntry): QoderModelEntry {
  const contextConfig = entry.context_config;
  if (!contextConfig || typeof contextConfig !== "object") return entry;

  const maxTokenCount = Math.max(
    ...Object.values(contextConfig).map((config) => (typeof config?.token_count === "number" ? config.token_count : 0)),
  );
  if (maxTokenCount <= 0) return entry;

  return {
    ...entry,
    context_config: Object.fromEntries(
      Object.entries(contextConfig).map(([name, config]) => [
        name,
        { ...config, is_default: config.token_count === maxTokenCount },
      ]),
    ),
  };
}

export function isCacheStale(mode?: string): boolean {
  const cachePath = getQoderCachePath(mode);
  if (!existsSync(cachePath)) return true;
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!data || typeof data.updatedAt !== "number") return true;
    // Stale if older than 1 hour
    return Date.now() - data.updatedAt > 3600_000;
  } catch {
    return true;
  }
}

export async function updateQoderModelsCache(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  mode: string = getQoderMode(),
): Promise<void> {
  const modelListURL = getQoderModelListURL(mode);
  try {
    // auth 类：官方在这类请求上发 Cosy-ClientIp 与 Accept-Encoding: identity，
    // 不发 Connection / Cache-Control（台账差异第 10、11 行）。
    const headers = buildAuthHeaders(
      null,
      modelListURL,
      {
        userID,
        authToken,
        name,
        email,
      },
      "auth",
    );

    const response = await fetch(modelListURL, {
      method: "GET",
      headers: {
        // 官方即使是无体 GET 也带 Content-Type（台账差异第 12 行）。
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return;
    }

    // 官方对目录响应过一遍 decrypt_server_response（台账差异第 40 行）。它对明文恒等，
    // 所以今天等于无操作；服务端哪天改成编码返回时，这里才是优雅处理与满屏乱码的区别。
    const resData = parseQoderJsonBody<{
      chat?: QoderModelEntry[];
      assistant?: QoderModelEntry[];
      [scene: string]: unknown;
    }>(await response.text());
    // Official merges every scene in the response into one catalog (ledger row 41,
    // pretty.mjs:105953-105970): the configured scene (assistant) goes first and
    // wins on duplicate keys; byok_enterprise entries it lacks are merged into it
    // (pretty.mjs:105500-105514). A missing configured scene warns but does not
    // fail; the old silent assistant||chat fallback swapped catalogs with no sign.
    const configScene = "assistant";
    const sceneNames = Object.keys(resData).filter((s) => Array.isArray(resData[s]));
    if (!sceneNames.includes(configScene)) {
      console.warn(
        `[pi-provider-qoder] catalog has no "${configScene}" scene; merging the scenes the server sent: ${sceneNames.join(", ")}`,
      );
    }
    const orderedScenes = [configScene, ...sceneNames.filter((s) => s !== configScene && s !== "byok_enterprise")];

    const mergedEntries: QoderModelEntry[] = [];
    const seenKeys = new Set<string>();
    for (const scene of orderedScenes) {
      // `pretty.mjs:105956`: a scene that is absent or not an array is skipped —
      // the configured scene may be missing entirely, which is the warn case above.
      const sceneEntries = resData[scene];
      if (!Array.isArray(sceneEntries)) continue;
      let entries = sceneEntries as QoderModelEntry[];
      if (scene === configScene) {
        const byok = resData.byok_enterprise;
        if (Array.isArray(byok) && byok.length > 0) {
          const have = new Set(entries.map((e) => e?.key).filter((k): k is string => !!k));
          const extra = (byok as QoderModelEntry[]).filter((e) => e?.key && !have.has(e.key));
          // byok 条目带着自己的 scene 标记并入（官方 EXH 记 `serverScene: byok_enterprise`）。
          entries = [...entries, ...extra.map((e) => ({ ...e, server_scene: "byok_enterprise" }))];
        }
      }
      for (const entry of entries) {
        const key = entry?.key;
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        mergedEntries.push(
          scene === configScene && !entry.server_scene
            ? { ...entry, server_scene: scene }
            : { ...entry, server_scene: entry.server_scene ?? scene },
        );
      }
    }
    const chatModels = mergedEntries;
    if (chatModels.length === 0) return;

    const newModels: QoderModelDef[] = [];
    const configs: Record<string, QoderModelEntry> = {};

    for (const entry of chatModels) {
      const key = entry.key;
      if (!key || entry.enable === false || entry.enable === 0) continue;

      const display = entry.display_name || key;
      let ctxLen = entry.max_input_tokens || 180000;
      if (entry.context_config && typeof entry.context_config === "object") {
        for (const configVal of Object.values(entry.context_config)) {
          if (configVal && typeof configVal === "object" && typeof configVal.token_count === "number") {
            const tc = configVal.token_count;
            if (tc > ctxLen) {
              ctxLen = tc;
            }
          }
        }
      }
      const isVL = !!entry.is_vl;
      const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;
      const supportsEffort = !!entry.thinking_config?.enabled?.efforts;
      const modelInfo = isQoderCNMode(mode) ? getQoderCNFriendlyModelInfo(key, display) : { id: key, name: display };

      configs[key] = entry;
      if (modelInfo.id !== key) configs[modelInfo.id] = entry;

      newModels.push({
        id: modelInfo.id,
        name: modelInfo.name,
        api: "qoder-api",
        provider: isQoderCNMode(mode) ? "qoder-cn" : "qoder",
        baseUrl: getQoderBaseUrl(mode),
        reasoning: isReasoning,
        supportsEffort,
        input: isVL ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: ctxLen,
        maxTokens: entry.max_output_tokens || 32768,
      });
    }

    if (newModels.length === 0) return;

    const cacheData = {
      updatedAt: Date.now(),
      models: newModels,
      configs,
    };

    const cachePath = getQoderCachePath(mode);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");
  } catch (e) {
    console.error("[pi-provider-qoder] Failed to update model cache:", e);
  }
}
