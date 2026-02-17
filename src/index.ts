/**
 * OpenViking Memory Plugin for OpenClaw
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { OpenVikingMemoryManager } from "./manager.js";
import { OpenVikingServerManager } from "./server.js";
import type { MemorySearchManager } from "./memory.js";
import type { OpenVikingPluginConfig } from "./types.js";

export type { OpenVikingPluginConfig } from "./types.js";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult
} from "./memory.js";
export { OpenVikingMemoryManager } from "./manager.js";
export { OpenVikingClient } from "./client.js";
export { PathMapper } from "./mapper.js";
export { OpenVikingServerManager } from "./server.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number())
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number())
});

type PluginToolContext = {
  workspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
};

const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseUrl"],
  properties: {
    baseUrl: { type: "string" },
    apiKey: { type: "string" },
    uriBase: { type: "string" },
    tieredLoading: { type: "boolean" },
    mappings: {
      type: "object",
      additionalProperties: { type: "string" }
    },
    sync: {
      type: "object",
      additionalProperties: false,
      properties: {
        interval: { type: "string" },
        onBoot: { type: "boolean" },
        waitForProcessing: { type: "boolean" },
        waitTimeoutSec: { type: "number", minimum: 0 }
      }
    },
    search: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["find", "search"] },
        defaultLimit: { type: "number", minimum: 1 },
        scoreThreshold: { type: "number", minimum: 0, maximum: 1 },
        targetUri: { type: "string" }
      }
    },
    server: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "venvPath"],
      properties: {
        enabled: { type: "boolean" },
        venvPath: { type: "string" },
        dataDir: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        startupTimeoutMs: { type: "number", minimum: 1000 },
        env: { type: "object", additionalProperties: { type: "string" } }
      }
    }
  }
} as const;

const plugin = {
  id: "openclaw-memory-openviking",
  name: "OpenViking Memory",
  description: "OpenViking-backed memory_search/memory_get tools for OpenClaw",
  version: "0.1.0",
  kind: "memory",
  configSchema: {
    jsonSchema: configSchema,
    uiHints: {
      baseUrl: {
        label: "OpenViking Base URL",
        placeholder: "http://127.0.0.1:1933",
        help: "OpenViking HTTP 服务地址"
      },
      apiKey: {
        label: "API Key",
        sensitive: true,
        help: "可选：OpenViking API Key"
      },
      uriBase: {
        label: "URI Base",
        advanced: true,
        placeholder: "viking://resources/openclaw/{agentId}",
        help: "资源根路径，支持 {agentId} 占位符"
      },
      tieredLoading: {
        label: "Tiered Loading",
        advanced: true,
        help: "memory_get 未指定行号时优先返回目录概览（L1）"
      },
      "sync.interval": {
        label: "Sync Interval",
        advanced: true,
        placeholder: "5m",
        help: "自动同步间隔（例如 30s/5m/1h）"
      },
      "sync.onBoot": {
        label: "Sync On Boot",
        advanced: true
      },
      "sync.waitForProcessing": {
        label: "Wait For Processing",
        advanced: true,
        help: "同步后等待 OpenViking 队列处理完成"
      },
      "search.mode": {
        label: "Search Mode",
        advanced: true,
        help: "find=快速检索，search=带会话语义"
      },
      "search.targetUri": {
        label: "Target URI",
        advanced: true,
        help: "限定检索范围"
      },
      "server.enabled": {
        label: "Auto-start OpenViking",
        advanced: true
      },
      "server.venvPath": {
        label: "OpenViking Venv Path",
        advanced: true,
        placeholder: "/path/to/venv"
      }
    }
  },
  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    api.logger.info(`openviking plugin loaded (baseUrl=${cfg.baseUrl})`);

    const managers = new Map<string, OpenVikingMemoryManager>();
    const bootSyncDone = new Set<string>();
    let serverManager: OpenVikingServerManager | undefined;
    let serverStarted = false;
    let serverStartPromise: Promise<void> | null = null;
    let syncTimer: NodeJS.Timeout | null = null;

    const ensureServer = async (): Promise<void> => {
      if (!cfg.server?.enabled) {
        return;
      }
      if (serverStarted) {
        return;
      }
      if (serverStartPromise) {
        await serverStartPromise;
        return;
      }
      serverManager = new OpenVikingServerManager({
        config: cfg.server,
        logger: api.logger
      });
      serverStartPromise = serverManager.start();
      await serverStartPromise;
      serverStarted = true;
    };

    const managerKey = (workspaceDir: string, agentId: string): string => `${workspaceDir}::${agentId}`;

    const getManager = async (ctx: PluginToolContext): Promise<MemorySearchManager> => {
      const workspaceDir = ctx.workspaceDir ?? process.cwd();
      const agentId = ctx.agentId ?? "main";
      const key = managerKey(workspaceDir, agentId);

      await ensureServer();

      let manager = managers.get(key);
      if (!manager) {
        manager = new OpenVikingMemoryManager({
          config: cfg,
          workspaceDir,
          agentId,
          logger: api.logger
        });
        managers.set(key, manager);
      }

      if (!bootSyncDone.has(key) && cfg.sync?.onBoot !== false) {
        bootSyncDone.add(key);
        manager
          .sync({ reason: "boot" })
          .catch((error) => api.logger.warn(`openviking boot sync failed (${agentId}): ${String(error)}`));
      }

      return manager;
    };

    const memorySearchToolFactory = (ctx: PluginToolContext): AnyAgentTool[] => {
      const memorySearchTool: AnyAgentTool = {
        label: "Memory Search",
        name: "memory_search",
        description:
          "Search memory content in OpenViking before answering questions about prior decisions, people, preferences, tasks, and historical context.",
        parameters: MemorySearchSchema,
        execute: async (_toolCallId, params) => {
          const payload = (params ?? {}) as Record<string, unknown>;
          const query = readStringParam(payload, "query");
          const maxResults = readOptionalNumber(payload, "maxResults");
          const minScore = readOptionalNumber(payload, "minScore");

          if (!query) {
            return jsonResult({ results: [], disabled: true, error: "query required" });
          }

          try {
            const manager = await getManager(ctx);
            const results = await manager.search(query, {
              maxResults: maxResults ?? undefined,
              minScore: minScore ?? undefined,
              sessionKey: ctx.sessionKey
            });
            const status = manager.status();
            return jsonResult({
              results,
              provider: status.provider,
              model: status.model
            });
          } catch (error) {
            return jsonResult({
              results: [],
              disabled: true,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      };

      const memoryGetTool: AnyAgentTool = {
        label: "Memory Get",
        name: "memory_get",
        description:
          "Read a specific memory file path from OpenViking (optionally by line range) after running memory_search.",
        parameters: MemoryGetSchema,
        execute: async (_toolCallId, params) => {
          const payload = (params ?? {}) as Record<string, unknown>;
          const relPath = readStringParam(payload, "path");
          const from = readOptionalInteger(payload, "from");
          const lines = readOptionalInteger(payload, "lines");

          if (!relPath) {
            return jsonResult({ path: "", text: "", disabled: true, error: "path required" });
          }

          try {
            const manager = await getManager(ctx);
            const result = await manager.readFile({
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined
            });
            return jsonResult(result);
          } catch (error) {
            return jsonResult({
              path: relPath,
              text: "",
              disabled: true,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      };

      return [memorySearchTool, memoryGetTool];
    };

    api.registerTool(memorySearchToolFactory, { names: ["memory_search", "memory_get"] });

    const intervalMs = parseInterval(cfg.sync?.interval);
    if (intervalMs > 0) {
      syncTimer = setInterval(() => {
        for (const manager of managers.values()) {
          manager.sync?.({ reason: "interval" }).catch((error) => {
            api.logger.warn(`openviking scheduled sync failed: ${String(error)}`);
          });
        }
      }, intervalMs);
    }

    api.on("gateway_stop", async () => {
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      await Promise.all(
        [...managers.values()].map(async (manager) => {
          await manager.close?.().catch(() => undefined);
        })
      );
      managers.clear();
      if (serverManager) {
        await serverManager.stop().catch((error) => {
          api.logger.warn(`failed to stop openviking server: ${String(error)}`);
        });
      }
    });
  }
};

function resolveConfig(raw: unknown): OpenVikingPluginConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : "";
  if (!baseUrl) {
    throw new Error("OpenViking config invalid: baseUrl is required");
  }

  const searchRaw =
    input.search && typeof input.search === "object" ? (input.search as Record<string, unknown>) : {};
  const syncRaw =
    input.sync && typeof input.sync === "object" ? (input.sync as Record<string, unknown>) : {};
  const serverRaw =
    input.server && typeof input.server === "object" ? (input.server as Record<string, unknown>) : undefined;

  return {
    baseUrl,
    apiKey: typeof input.apiKey === "string" ? input.apiKey : undefined,
    uriBase: typeof input.uriBase === "string" ? input.uriBase : undefined,
    tieredLoading: typeof input.tieredLoading === "boolean" ? input.tieredLoading : true,
    mappings:
      input.mappings && typeof input.mappings === "object"
        ? (input.mappings as Record<string, string>)
        : undefined,
    search: {
      mode: searchRaw.mode === "search" ? "search" : "find",
      defaultLimit:
        typeof searchRaw.defaultLimit === "number" && Number.isFinite(searchRaw.defaultLimit)
          ? searchRaw.defaultLimit
          : 6,
      scoreThreshold:
        typeof searchRaw.scoreThreshold === "number" && Number.isFinite(searchRaw.scoreThreshold)
          ? searchRaw.scoreThreshold
          : 0.0,
      targetUri: typeof searchRaw.targetUri === "string" ? searchRaw.targetUri : undefined
    },
    sync: {
      interval: typeof syncRaw.interval === "string" ? syncRaw.interval : undefined,
      onBoot: typeof syncRaw.onBoot === "boolean" ? syncRaw.onBoot : true,
      waitForProcessing:
        typeof syncRaw.waitForProcessing === "boolean" ? syncRaw.waitForProcessing : false,
      waitTimeoutSec:
        typeof syncRaw.waitTimeoutSec === "number" && Number.isFinite(syncRaw.waitTimeoutSec)
          ? syncRaw.waitTimeoutSec
          : undefined
    },
    server: resolveServerConfig(serverRaw)
  };
}

function resolveServerConfig(
  serverRaw: Record<string, unknown> | undefined
): OpenVikingPluginConfig["server"] {
  if (!serverRaw || serverRaw.enabled !== true) {
    return undefined;
  }
  if (typeof serverRaw.venvPath !== "string" || !serverRaw.venvPath.trim()) {
    throw new Error("OpenViking config invalid: server.venvPath is required when server.enabled=true");
  }
  return {
    enabled: true,
    venvPath: serverRaw.venvPath.trim(),
    dataDir: typeof serverRaw.dataDir === "string" ? serverRaw.dataDir : undefined,
    host: typeof serverRaw.host === "string" ? serverRaw.host : undefined,
    port:
      typeof serverRaw.port === "number" && Number.isFinite(serverRaw.port)
        ? Math.trunc(serverRaw.port)
        : undefined,
    startupTimeoutMs:
      typeof serverRaw.startupTimeoutMs === "number" && Number.isFinite(serverRaw.startupTimeoutMs)
        ? Math.trunc(serverRaw.startupTimeoutMs)
        : undefined,
    env: isStringRecord(serverRaw.env) ? serverRaw.env : undefined
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function parseInterval(interval?: string): number {
  if (!interval) {
    return 0;
  }
  const match = interval.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    return 0;
  }
  const amount = Math.max(0, Number.parseInt(match[1], 10));
  const unit = match[2].toLowerCase();
  const multiplier: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
  };
  return amount * (multiplier[unit] ?? 0);
}

function readStringParam(params: Record<string, unknown>, key: string): string {
  const raw = params[key];
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim();
}

function readOptionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const raw = params[key];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readOptionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = readOptionalNumber(params, key);
  if (value === undefined) {
    return undefined;
  }
  return Math.trunc(value);
}

function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    details: payload
  };
}

export default plugin;
