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
        ovConfigPath: { type: "string" },
        extraPaths: {
          type: "array",
          items: { type: "string" }
        },
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
  version: "0.1.1",
  kind: "memory",
  configSchema: {
    jsonSchema: configSchema,
    uiHints: {
      baseUrl: {
        label: "OpenViking Base URL",
        placeholder: "http://127.0.0.1:1933",
        help: "OpenViking HTTP endpoint."
      },
      apiKey: {
        label: "API Key",
        sensitive: true,
        help: "Optional API key when OpenViking auth is enabled."
      },
      uriBase: {
        label: "URI Base",
        advanced: true,
        placeholder: "viking://resources/openclaw/{agentId}",
        help: "Resource root URI. Supports the {agentId} placeholder."
      },
      tieredLoading: {
        label: "Tiered Loading",
        advanced: true,
        help: "When true, memory_get uses overview first (for whole-file reads) and falls back to full read."
      },
      "sync.interval": {
        label: "Sync Interval",
        advanced: true,
        placeholder: "5m",
        help: "Automatic sync interval. Supported units: s, m, h, d (e.g. 30s, 5m, 1h)."
      },
      "sync.onBoot": {
        label: "Sync On Boot",
        advanced: true,
        help: "Run one sync after plugin startup."
      },
      "sync.ovConfigPath": {
        label: "ov.conf Path",
        advanced: true,
        help: "Optional ov.conf path. If the file fingerprint changes, the next sync runs a full resync."
      },
      "sync.extraPaths": {
        label: "Extra Paths",
        advanced: true,
        help: "Additional files/directories to sync. Paths are workspace-relative; directories are scanned recursively for .md files."
      },
      "sync.waitForProcessing": {
        label: "Wait For Processing",
        advanced: true,
        help: "Wait until OpenViking processing queues finish after sync."
      },
      "sync.waitTimeoutSec": {
        label: "Wait Timeout (sec)",
        advanced: true,
        help: "Timeout in seconds for waitForProcessing."
      },
      "search.mode": {
        label: "Search Mode",
        advanced: true,
        help: "search: session-aware retrieval (default). find: stateless retrieval for low-latency lookups."
      },
      "search.defaultLimit": {
        label: "Default Limit",
        advanced: true,
        help: "Default max result count if memory_search.maxResults is not provided."
      },
      "search.scoreThreshold": {
        label: "Score Threshold",
        advanced: true,
        help: "Minimum similarity score in [0, 1]."
      },
      "search.targetUri": {
        label: "Target URI",
        advanced: true,
        help: "Restrict search to a specific URI subtree."
      },
      "server.enabled": {
        label: "Auto-start OpenViking",
        advanced: true,
        help: "If true, the plugin starts/stops an OpenViking process automatically."
      },
      "server.venvPath": {
        label: "OpenViking Venv Path",
        advanced: true,
        placeholder: "/path/to/venv",
        help: "Required when server.enabled=true. Points to the Python virtual environment root."
      },
      "server.dataDir": {
        label: "OpenViking Data Dir",
        advanced: true,
        help: "Optional data directory passed to openviking serve --data-dir."
      },
      "server.host": {
        label: "OpenViking Host",
        advanced: true,
        help: "Host for auto-started OpenViking server. Defaults to 127.0.0.1."
      },
      "server.port": {
        label: "OpenViking Port",
        advanced: true,
        help: "Port for auto-started OpenViking server. Defaults to 1933."
      },
      "server.startupTimeoutMs": {
        label: "Startup Timeout (ms)",
        advanced: true,
        help: "Max wait time for OpenViking health check during startup."
      },
      "server.env": {
        label: "Server Env",
        advanced: true,
        help: "Extra environment variables for the auto-started OpenViking process."
      }
    }
  },
  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    api.logger.info(`openviking plugin loaded (baseUrl=${cfg.baseUrl})`);

    const managers = new Map<string, OpenVikingMemoryManager>();
    const bootSyncSucceeded = new Set<string>();
    const bootSyncRunning = new Set<string>();
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

      if (cfg.sync?.onBoot !== false && !bootSyncSucceeded.has(key) && !bootSyncRunning.has(key)) {
        bootSyncRunning.add(key);
        manager
          .sync({ reason: "boot" })
          .then(() => {
            bootSyncSucceeded.add(key);
          })
          .catch((error) => {
            api.logger.warn(`openviking boot sync failed (${agentId}): ${String(error)}`);
          })
          .finally(() => {
            bootSyncRunning.delete(key);
          });
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
      mode: searchRaw.mode === "find" ? "find" : "search",
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
      ovConfigPath: typeof syncRaw.ovConfigPath === "string" ? syncRaw.ovConfigPath : undefined,
      extraPaths: parseStringArray(syncRaw.extraPaths),
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

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const cleaned = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (cleaned.length === 0) {
    return undefined;
  }
  return [...new Set(cleaned)];
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
