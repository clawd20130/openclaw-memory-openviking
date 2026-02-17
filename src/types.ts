/**
 * OpenViking 插件类型定义
 */

export interface OpenVikingPluginConfig {
  /** OpenViking HTTP 服务地址 */
  baseUrl: string;
  /** 可选 API Key */
  apiKey?: string;
  /** OpenViking 资源前缀，默认 viking://resources/openclaw */
  uriBase?: string;
  /** 路径映射规则（本地路径 -> Viking URI 根路径） */
  mappings?: PathMappingConfig;
  /** 启用分层读取（L1/L2） */
  tieredLoading?: boolean;
  /** 同步配置 */
  sync?: SyncConfig;
  /** 检索配置 */
  search?: SearchConfig;
  /** 自动启动 OpenViking 服务 */
  server?: ServerConfig;
}

export interface ServerConfig {
  /** 是否自动启动 */
  enabled: boolean;
  /** Python venv 路径 */
  venvPath: string;
  /** 数据目录 */
  dataDir?: string;
  /** 主机地址，默认 127.0.0.1 */
  host?: string;
  /** 端口，默认 1933 */
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
  /** 启动时同步，默认 true */
  onBoot?: boolean;
  /** 额外同步路径（相对 workspace） */
  extraPaths?: string[];
  /** 同步时等待队列处理完成 */
  waitForProcessing?: boolean;
  /** 等待超时（秒） */
  waitTimeoutSec?: number;
}

export interface SearchConfig {
  /** 检索方法：find（默认）或 search（带会话语义） */
  mode?: "find" | "search";
  /** 默认返回结果数 */
  defaultLimit?: number;
  /** 最低相似度阈值（0-1） */
  scoreThreshold?: number;
  /** 限定检索 URI 前缀 */
  targetUri?: string;
}

export type OpenVikingContextType = "memory" | "resource" | "skill";

export interface OpenVikingApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface OpenVikingApiResponse<T> {
  status: "ok" | "error";
  result?: T;
  error?: OpenVikingApiError;
  time?: number;
}

export interface OpenVikingFindRequest {
  query: string;
  target_uri?: string;
  limit?: number;
  score_threshold?: number;
  filter?: Record<string, unknown>;
  session_id?: string;
}

export interface OpenVikingMatchedContext {
  uri: string;
  context_type: OpenVikingContextType;
  is_leaf: boolean;
  abstract: string;
  category?: string;
  score: number;
  match_reason?: string;
  relations?: Array<Record<string, unknown>>;
}

export interface OpenVikingFindResult {
  memories: OpenVikingMatchedContext[];
  resources: OpenVikingMatchedContext[];
  skills: OpenVikingMatchedContext[];
  total: number;
  query_plan?: Record<string, unknown>;
  query_results?: Array<Record<string, unknown>>;
}

export interface OpenVikingAddResourceRequest {
  path: string;
  target?: string;
  reason?: string;
  instruction?: string;
  wait?: boolean;
  timeout?: number;
}

export interface OpenVikingAddResourceResult {
  status: string;
  root_uri: string;
  source_path: string;
  errors?: string[];
  queue_status?: Record<string, unknown>;
}

export interface OpenVikingAddSkillRequest {
  data: unknown;
  wait?: boolean;
  timeout?: number;
}

export interface OpenVikingHealthStatus {
  status: "ok" | "error" | string;
}

export interface OpenVikingSystemStatus {
  initialized: boolean;
  user: string;
}
