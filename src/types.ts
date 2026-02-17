/**
 * OpenViking 插件类型定义
 */

export interface OpenVikingPluginConfig {
  /** OpenViking HTTP 服务地址 (如果 autoStart 启用，这是服务启动后的地址) */
  baseUrl: string;
  /** 可选 API Key */
  apiKey?: string;
  /** 路径映射规则 */
  mappings?: PathMappingConfig;
  /** 启用分层加载 */
  tieredLoading?: boolean;
  /** 自动生成分层内容 */
  autoLayering?: boolean;
  /** 同步配置 */
  sync?: SyncConfig;
  /** 搜索配置 */
  search?: SearchConfig;
  /** 自动启动 OpenViking 服务 */
  server?: ServerConfig;
}

export interface ServerConfig {
  /** 是否自动启动 */
  enabled: boolean;
  /** venv 路径 */
  venvPath: string;
  /** 数据目录 */
  dataDir?: string;
  /** 主机地址，默认 127.0.0.1 */
  host?: string;
  /** 端口，默认 8080 */
  port?: number;
  /** 启动超时，默认 30000ms */
  startupTimeoutMs?: number;
  /** 额外环境变量 */
  env?: Record<string, string>;
}

export interface PathMappingConfig {
  [localPath: string]: string;
}

export interface SyncConfig {
  /** 同步间隔，默认 "5m" */
  interval?: string;
  /** 启动时同步 */
  onBoot?: boolean;
  /** 防抖时间，默认 5000ms */
  debounceMs?: number;
}

export interface SearchConfig {
  /** 搜索模式 */
  mode?: "semantic" | "filesystem" | "hybrid";
  /** 使用目录上下文 */
  useDirectoryContext?: boolean;
  /** 默认返回结果数 */
  defaultLimit?: number;
}

// OpenViking API 类型

export interface OpenVikingSearchRequest {
  query: string;
  limit?: number;
  threshold?: number;
  mode?: "semantic" | "filesystem" | "hybrid";
  context?: string;
}

export interface OpenVikingSearchResult {
  uri: string;
  content: string;
  score: number;
  layer: "L0" | "L1" | "L2";
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
}

export interface OpenVikingDocument {
  uri: string;
  content: string;
  layers: {
    L0?: string;
    L1?: string;
    L2: string;
  };
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export interface OpenVikingHealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  collections: string[];
}
