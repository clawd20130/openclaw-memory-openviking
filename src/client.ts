/**
 * OpenViking HTTP 客户端
 */

import type {
  OpenVikingPluginConfig,
  OpenVikingSearchRequest,
  OpenVikingSearchResult,
  OpenVikingDocument,
  OpenVikingHealthStatus
} from "./types.js";

export class OpenVikingClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(config: Pick<OpenVikingPluginConfig, "baseUrl" | "apiKey"> & { timeoutMs?: number }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      "Accept": "application/json"
    };
    if (this.apiKey) {
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

  /**
   * 搜索文档
   */
  async search(request: OpenVikingSearchRequest): Promise<OpenVikingSearchResult[]> {
    const url = `${this.baseUrl}/api/v1/search`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenViking search failed: ${response.status} ${error}`);
    }

    return response.json();
  }

  /**
   * 获取文档内容
   */
  async getDocument(uri: string, layer?: "L0" | "L1" | "L2"): Promise<OpenVikingDocument> {
    const params = new URLSearchParams();
    params.append("uri", uri);
    if (layer) params.append("layer", layer);

    const url = `${this.baseUrl}/api/v1/documents?${params}`;
    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.getHeaders()
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Document not found: ${uri}`);
      }
      const error = await response.text();
      throw new Error(`OpenViking get document failed: ${response.status} ${error}`);
    }

    return response.json();
  }

  /**
   * 创建或更新文档
   */
  async upsertDocument(document: Omit<OpenVikingDocument, "updatedAt">): Promise<void> {
    const url = `${this.baseUrl}/api/v1/documents`;
    const response = await this.fetchWithTimeout(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(document)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenViking upsert failed: ${response.status} ${error}`);
    }
  }

  /**
   * 删除文档
   */
  async deleteDocument(uri: string): Promise<void> {
    const url = `${this.baseUrl}/api/v1/documents?uri=${encodeURIComponent(uri)}`;
    const response = await this.fetchWithTimeout(url, {
      method: "DELETE",
      headers: this.getHeaders()
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`OpenViking delete failed: ${response.status} ${error}`);
    }
  }

  /**
   * 健康检查
   */
  async health(): Promise<OpenVikingHealthStatus> {
    const url = `${this.baseUrl}/health`;
    try {
      const response = await this.fetchWithTimeout(url, {
        method: "GET",
        headers: { "Accept": "application/json" }
      });

      if (!response.ok) {
        return {
          status: "unhealthy",
          version: "unknown",
          collections: []
        };
      }

      return response.json();
    } catch {
      return {
        status: "unhealthy",
        version: "unknown",
        collections: []
      };
    }
  }

  /**
   * 列出所有文档 URI
   */
  async listDocuments(prefix?: string): Promise<string[]> {
    const params = new URLSearchParams();
    if (prefix) params.append("prefix", prefix);

    const url = `${this.baseUrl}/api/v1/documents/list?${params}`;
    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.getHeaders()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenViking list failed: ${response.status} ${error}`);
    }

    return response.json();
  }
}
