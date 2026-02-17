/**
 * OpenViking Memory Plugin for OpenClaw
 * 
 * 将 OpenViking 作为记忆后端，提供分层上下文管理和自我进化能力。
 */

// Note: @openclaw/plugin-sdk is a peer dependency
// The actual package name may vary based on OpenClaw SDK release
import type { 
  OpenClawPluginDefinition,
  OpenClawPluginApi
} from "@kevinzhow/openclaw-plugin-sdk";
import type { OpenVikingPluginConfig } from "./types.js";
import { OpenVikingMemoryManager } from "./manager.js";
import { OpenVikingServerManager } from "./server.js";

// 重新导出类型
export type { OpenVikingPluginConfig } from "./types.js";
export { OpenVikingMemoryManager } from "./manager.js";
export { OpenVikingClient } from "./client.js";
export { PathMapper } from "./mapper.js";
export { OpenVikingServerManager } from "./server.js";

/**
 * 配置校验函数
 */
function validateConfig(config: unknown): { ok: true; data: OpenVikingPluginConfig } | { ok: false; errors: string[] } {
  if (typeof config !== "object" || config === null) {
    return { ok: false, errors: ["Config must be an object"] };
  }

  const cfg = config as Record<string, unknown>;
  const errors: string[] = [];

  // 检查必需字段
  if (!cfg.baseUrl) {
    errors.push("Missing required field: baseUrl");
  } else if (typeof cfg.baseUrl !== "string") {
    errors.push("baseUrl must be a string");
  }

  // 检查可选字段类型
  if (cfg.apiKey !== undefined && typeof cfg.apiKey !== "string") {
    errors.push("apiKey must be a string");
  }

  if (cfg.tieredLoading !== undefined && typeof cfg.tieredLoading !== "boolean") {
    errors.push("tieredLoading must be a boolean");
  }

  if (cfg.autoLayering !== undefined && typeof cfg.autoLayering !== "boolean") {
    errors.push("autoLayering must be a boolean");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, data: cfg as OpenVikingPluginConfig };
}

/**
 * 插件定义
 */
const plugin: OpenClawPluginDefinition = {
  id: "openviking",
  name: "OpenViking Memory",
  description: "OpenViking context database as memory backend for OpenClaw",
  version: "0.1.0",
  kind: "memory",  // 声明为 memory 插件

  /**
   * 配置模式定义
   */
  configSchema: {
    safeParse: validateConfig,
    uiHints: {
      baseUrl: {
        label: "OpenViking Base URL",
        help: "HTTP endpoint of OpenViking service (e.g., http://localhost:8080). If auto-start is enabled, this is where the server will be available.",
        placeholder: "http://127.0.0.1:1933"
      },
      apiKey: {
        label: "API Key",
        help: "Optional API key for authentication",
        sensitive: true
      },
      tieredLoading: {
        label: "Tiered Loading",
        help: "Enable L0/L1/L2 tiered content loading to save tokens",
        advanced: true
      },
      autoLayering: {
        label: "Auto Layering",
        help: "Automatically generate L0/L1 summaries on sync",
        advanced: true
      },
      "server.enabled": {
        label: "Auto-start Server",
        help: "Automatically start OpenViking server using the local venv",
        advanced: true
      },
      "server.venvPath": {
        label: "Virtual Environment Path",
        help: "Path to Python venv containing openviking package (e.g., /home/kevinzhow/openviking/venv)",
        placeholder: "/path/to/venv"
      },
      "server.dataDir": {
        label: "Data Directory",
        help: "Optional: Path to OpenViking data directory",
        placeholder: "/path/to/data"
      }
    }
  },

  /**
   * 注册插件
   * 在 OpenClaw 启动时调用
   */
  register: async (api: OpenClawPluginApi) => {
    api.logger.info("OpenViking memory plugin registered");
  },

  /**
   * 激活插件
   * 在配置加载完成后调用，创建并注册 MemoryManager
   */
  activate: async (api: OpenClawPluginApi) => {
    // 获取插件配置
    const rawConfig = api.pluginConfig;
    const validation = validateConfig(rawConfig);

    if (!validation.ok) {
      api.logger.error(`OpenViking config invalid: ${validation.errors.join(", ")}`);
      throw new Error(`Invalid OpenViking configuration: ${validation.errors.join(", ")}`);
    }

    const config = validation.data;
    api.logger.info(`OpenViking activating with baseUrl: ${config.baseUrl}`);

    // 如果需要，自动启动 OpenViking 服务
    let serverManager: OpenVikingServerManager | undefined;
    if (config.server?.enabled) {
      serverManager = new OpenVikingServerManager({
        config: config.server,
        logger: api.logger
      });
      await serverManager.start();
    }

    // 创建 memory manager
    const manager = new OpenVikingMemoryManager({
      config,
      workspaceDir: api.runtime.workspaceDir ?? process.cwd(),
      agentId: api.runtime.agentId ?? "default",
      logger: api.logger
    });

    // 健康检查
    try {
      const probe = await manager.probeEmbeddingAvailability();
      if (!probe.ok) {
        api.logger.warn(`OpenViking health check failed: ${probe.error}`);
      } else {
        api.logger.info("OpenViking health check passed");
      }
    } catch (error) {
      api.logger.error(`OpenViking health check error: ${error}`);
    }

    // 注册 memory backend
    // 注意: 实际注册方式取决于 OpenClaw Plugin SDK 的具体实现
    // 这里假设通过 runtime 提供的方法注册
    if (api.runtime.registerMemoryBackend) {
      api.runtime.registerMemoryBackend(manager);
      api.logger.info("OpenViking memory backend registered successfully");
    } else {
      // Fallback: 可能需要通过其他方式注册
      api.logger.warn("registerMemoryBackend not available in runtime, memory tools may not work");
    }

    // 启动时同步（如果配置开启）
    if (config.sync?.onBoot !== false) {
      try {
        await manager.sync({ reason: "boot" });
      } catch (error) {
        api.logger.error(`Initial sync failed: ${error}`);
      }
    }

    // 设置定时同步
    if (config.sync?.interval) {
      const intervalMs = parseInterval(config.sync.interval);
      if (intervalMs > 0) {
        const syncInterval = setInterval(() => {
          manager.sync({ reason: "scheduled" }).catch((err) => {
            api.logger.error(`Scheduled sync failed: ${err}`);
          });
        }, intervalMs);

        // 清理定时器
        api.on?.("gateway_stop", async () => {
          clearInterval(syncInterval);
          await manager.close();
          if (serverManager) {
            await serverManager.stop();
          }
        });
      }
    } else if (serverManager) {
      // 没有定时同步也要在关闭时停止服务
      api.on?.("gateway_stop", async () => {
        await manager.close();
        await serverManager!.stop();
      });
    }
  }
};

/**
 * 解析时间间隔字符串
 * 支持: 5m, 1h, 30s
 */
function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)([smhd])$/);
  if (!match) return 0;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  return value * (multipliers[unit] ?? 0);
}

// 导出插件作为默认和命名导出
export default plugin;
export { plugin as openvikingPlugin };
