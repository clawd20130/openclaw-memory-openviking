/**
 * OpenViking HTTP 客户端
 */

import type {
  OpenVikingAddResourceRequest,
  OpenVikingAddResourceResult,
  OpenVikingAddSkillRequest,
  OpenVikingApiResponse,
  OpenVikingFindRequest,
  OpenVikingFindResult,
  OpenVikingHealthStatus,
  OpenVikingPluginConfig,
  OpenVikingSystemStatus
} from "./types.js";

export class OpenVikingHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    message: string;
    status: number;
    code?: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = "OpenVikingHttpError";
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
  }
}

export class OpenVikingClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(config: Pick<OpenVikingPluginConfig, "baseUrl" | "apiKey"> & { timeoutMs?: number }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Accept": "application/json"
    };
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${this.timeoutMs}ms`);
      }
      throw error;
    }
  }

  private async request<T>(params: {
    path: string;
    method: "GET" | "POST" | "DELETE";
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    raw?: boolean;
  }): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params.query ?? {})) {
      if (value !== undefined) {
        query.append(key, String(value));
      }
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const url = `${this.baseUrl}${params.path}${suffix}`;
    const headers = this.getHeaders();
    let body: string | undefined;
    if (params.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params.body);
    }

    const response = await this.fetchWithTimeout(url, {
      method: params.method,
      headers,
      body
    });

    const rawText = await response.text();
    let parsed: unknown = undefined;
    if (rawText.trim()) {
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch {
        parsed = rawText;
      }
    }

    if (!response.ok) {
      const payload = parsed as OpenVikingApiResponse<unknown> | undefined;
      const message =
        payload?.error?.message ||
        (typeof parsed === "string" ? parsed : response.statusText) ||
        "Request failed";
      throw new OpenVikingHttpError({
        message: `OpenViking ${params.method} ${params.path} failed: ${message}`,
        status: response.status,
        code: payload?.error?.code,
        details: payload?.error?.details
      });
    }

    if (params.raw) {
      return parsed as T;
    }

    const payload = parsed as OpenVikingApiResponse<T> | undefined;
    if (!payload || typeof payload !== "object") {
      throw new OpenVikingHttpError({
        message: `OpenViking ${params.method} ${params.path} returned non-JSON payload`,
        status: response.status
      });
    }

    if (payload.status !== "ok") {
      throw new OpenVikingHttpError({
        message: `OpenViking error: ${payload.error?.message ?? "Unknown error"}`,
        status: response.status,
        code: payload.error?.code,
        details: payload.error?.details
      });
    }

    return payload.result as T;
  }

  /**
   * 基础语义检索（无会话上下文）
   */
  async find(request: OpenVikingFindRequest): Promise<OpenVikingFindResult> {
    return await this.request<OpenVikingFindResult>({
      method: "POST",
      path: "/api/v1/search/find",
      body: request
    });
  }

  /**
   * 带会话上下文的检索
   */
  async search(request: OpenVikingFindRequest): Promise<OpenVikingFindResult> {
    return await this.request<OpenVikingFindResult>({
      method: "POST",
      path: "/api/v1/search/search",
      body: request
    });
  }

  /**
   * 读取完整内容（L2）
   */
  async read(uri: string): Promise<string> {
    return await this.request<string>({
      method: "GET",
      path: "/api/v1/content/read",
      query: { uri }
    });
  }

  /**
   * 读取目录概览（L1）
   */
  async overview(uri: string): Promise<string> {
    return await this.request<string>({
      method: "GET",
      path: "/api/v1/content/overview",
      query: { uri }
    });
  }

  /**
   * 读取目录摘要（L0）
   */
  async abstract(uri: string): Promise<string> {
    return await this.request<string>({
      method: "GET",
      path: "/api/v1/content/abstract",
      query: { uri }
    });
  }

  /**
   * 导入资源
   */
  async addResource(request: OpenVikingAddResourceRequest): Promise<OpenVikingAddResourceResult> {
    return await this.request<OpenVikingAddResourceResult>({
      method: "POST",
      path: "/api/v1/resources",
      body: request
    });
  }

  /**
   * 导入技能
   */
  async addSkill(request: OpenVikingAddSkillRequest): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/skills",
      body: request
    });
  }

  /**
   * 删除资源
   */
  async remove(uri: string, recursive = false): Promise<void> {
    await this.request<{ uri: string }>({
      method: "DELETE",
      path: "/api/v1/fs",
      query: { uri, recursive }
    });
  }

  /**
   * 移动资源
   */
  async move(fromUri: string, toUri: string): Promise<void> {
    await this.request<{ from: string; to: string }>({
      method: "POST",
      path: "/api/v1/fs/mv",
      body: {
        from_uri: fromUri,
        to_uri: toUri
      }
    });
  }

  /**
   * 等待队列处理完成
   */
  async waitProcessed(timeoutSec?: number): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/system/wait",
      body: {
        timeout: timeoutSec
      }
    });
  }

  /**
   * 系统状态
   */
  async systemStatus(): Promise<OpenVikingSystemStatus> {
    return await this.request<OpenVikingSystemStatus>({
      method: "GET",
      path: "/api/v1/system/status"
    });
  }

  /**
   * 健康检查（此接口不走统一 result 包装）
   */
  async health(): Promise<OpenVikingHealthStatus> {
    return await this.request<OpenVikingHealthStatus>({
      method: "GET",
      path: "/health",
      raw: true
    });
  }
}
