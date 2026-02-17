/**
 * OpenViking Memory Manager - 实现 OpenClaw MemorySearchManager 接口
 */

import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryProviderStatus,
  MemorySyncProgressUpdate,
  MemoryEmbeddingProbeResult,
  MemorySource
} from "@openclaw/plugin-sdk";
import type { OpenVikingPluginConfig } from "./types.js";
import { OpenVikingClient } from "./client.js";
import { PathMapper } from "./mapper.js";
import { promises as fs } from "fs";
import * as path from "path";

export interface OpenVikingMemoryManagerOptions {
  config: OpenVikingPluginConfig;
  workspaceDir: string;
  agentId: string;
  logger?: {
    debug?: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export class OpenVikingMemoryManager implements MemorySearchManager {
  private client: OpenVikingClient;
  private mapper: PathMapper;
  private config: OpenVikingPluginConfig;
  private workspaceDir: string;
  private agentId: string;
  private logger: OpenVikingMemoryManagerOptions["logger"];
  private closed = false;
  private lastSyncAt?: Date;

  constructor(options: OpenVikingMemoryManagerOptions) {
    this.config = options.config;
    this.workspaceDir = options.workspaceDir;
    this.agentId = options.agentId;
    this.logger = options.logger;
    
    this.client = new OpenVikingClient({
      baseUrl: options.config.baseUrl,
      apiKey: options.config.apiKey,
      timeoutMs: 30000
    });
    
    this.mapper = new PathMapper(options.config.mappings);
  }

  /**
   * 搜索记忆
   */
  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string }
  ): Promise<MemorySearchResult[]> {
    if (this.closed) {
      throw new Error("OpenVikingMemoryManager is closed");
    }

    this.logger?.debug?.(`Searching: ${query}`);

    try {
      const results = await this.client.search({
        query,
        limit: opts?.maxResults ?? this.config.search?.defaultLimit ?? 5,
        threshold: opts?.minScore ?? 0.5,
        mode: this.config.search?.mode ?? "hybrid"
      });

      // 转换为 OpenClaw 格式
      return results.map((r) => ({
        path: this.mapper.fromVikingUri(r.uri),
        startLine: r.startLine ?? 1,
        endLine: r.endLine ?? 1,
        score: r.score,
        snippet: r.content,
        source: this.inferSource(r.uri),
        citation: `${this.mapper.fromVikingUri(r.uri)}#${r.startLine ?? 1}`
      }));
    } catch (error) {
      this.logger?.error(`Search failed: ${error}`);
      throw error;
    }
  }

  /**
   * 读取文件内容
   */
  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    if (this.closed) {
      throw new Error("OpenVikingMemoryManager is closed");
    }

    const uri = this.mapper.toVikingUri(params.relPath);
    this.logger?.debug?.(`Reading file: ${params.relPath} -> ${uri}`);

    try {
      // 决定读取哪个层级
      let layer: "L0" | "L1" | "L2" | undefined;
      if (this.config.tieredLoading !== false) {
        // 默认读取 L1 (概览层)，如果需要完整内容再读 L2
        layer = params.lines && params.lines > 50 ? "L2" : "L1";
      }

      const doc = await this.client.getDocument(uri, layer);

      let text: string;
      if (layer === "L0") {
        text = doc.layers.L0 ?? doc.content;
      } else if (layer === "L1") {
        text = doc.layers.L1 ?? doc.content;
      } else {
        text = doc.content;
      }

      // 处理行范围
      if (params.from || params.lines) {
        const allLines = text.split("\n");
        const start = (params.from ?? 1) - 1;
        const end = params.lines
          ? Math.min(start + params.lines, allLines.length)
          : allLines.length;
        text = allLines.slice(start, end).join("\n");
      }

      return { text, path: params.relPath };
    } catch (error) {
      // 如果 OpenViking 中没有，尝试从本地文件读取（兼容性）
      this.logger?.warn?.(`OpenViking miss: ${uri}, trying local file`);
      return this.readLocalFile(params);
    }
  }

  /**
   * 从本地文件读取（fallback）
   */
  private async readLocalFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const fullPath = path.join(this.workspaceDir, params.relPath);
    
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      
      let text = content;
      if (params.from || params.lines) {
        const allLines = text.split("\n");
        const start = (params.from ?? 1) - 1;
        const end = params.lines
          ? Math.min(start + params.lines, allLines.length)
          : allLines.length;
        text = allLines.slice(start, end).join("\n");
      }

      return { text, path: params.relPath };
    } catch {
      throw new Error(`File not found: ${params.relPath}`);
    }
  }

  /**
   * 获取状态
   */
  status(): MemoryProviderStatus {
    const status: MemoryProviderStatus = {
      backend: "openviking" as any,  // 扩展类型
      provider: "openviking",
      files: -1,
      chunks: -1,
      custom: {
        baseUrl: this.config.baseUrl,
        tieredLoading: this.config.tieredLoading ?? true,
        autoLayering: this.config.autoLayering ?? true,
        lastSyncAt: this.lastSyncAt?.toISOString(),
        workspaceDir: this.workspaceDir
      }
    };

    return status;
  }

  /**
   * 同步文件到 OpenViking
   */
  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) return;

    this.logger?.info(`Syncing to OpenViking: ${params?.reason ?? "scheduled"}`);

    // 扫描需要同步的文件
    const filesToSync = await this.scanFiles();
    const total = filesToSync.length;

    params?.progress?.({ completed: 0, total, label: "Scanning files..." });

    let completed = 0;
    for (const filePath of filesToSync) {
      try {
        await this.syncFile(filePath);
        completed++;
        params?.progress?.({
          completed,
          total,
          label: `Syncing ${path.basename(filePath)}...`
        });
      } catch (error) {
        this.logger?.error(`Failed to sync ${filePath}: ${error}`);
      }
    }

    this.lastSyncAt = new Date();
    this.logger?.info(`Sync completed: ${completed}/${total} files`);
    params?.progress?.({ completed, total, label: "Sync completed" });
  }

  /**
   * 扫描需要同步的文件
   */
  private async scanFiles(): Promise<string[]> {
    const files: string[] = [];
    
    // 扫描 memory 目录
    const memoryDir = path.join(this.workspaceDir, "memory");
    try {
      const entries = await fs.readdir(memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(`memory/${entry.name}`);
        }
      }
    } catch {
      // 目录不存在，忽略
    }

    // 扫描根目录的关键文件
    const rootFiles = ["MEMORY.md", "SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md"];
    for (const file of rootFiles) {
      try {
        await fs.access(path.join(this.workspaceDir, file));
        files.push(file);
      } catch {
        // 文件不存在，忽略
      }
    }

    // 扫描 skills
    const skillsDir = path.join(this.workspaceDir, "skills");
    try {
      const skillDirs = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const dir of skillDirs) {
        if (dir.isDirectory()) {
          const skillFile = path.join("skills", dir.name, "SKILL.md");
          try {
            await fs.access(path.join(this.workspaceDir, skillFile));
            files.push(skillFile);
          } catch {
            // 忽略
          }
        }
      }
    } catch {
      // 目录不存在，忽略
    }

    return files;
  }

  /**
   * 同步单个文件
   */
  private async syncFile(relPath: string): Promise<void> {
    const fullPath = path.join(this.workspaceDir, relPath);
    const content = await fs.readFile(fullPath, "utf-8");
    const uri = this.mapper.toVikingUri(relPath);

    // 计算分层内容
    const layers = this.config.autoLayering !== false
      ? this.generateLayers(content)
      : { L2: content };

    await this.client.upsertDocument({
      uri,
      content,
      layers,
      metadata: {
        localPath: relPath,
        syncedAt: new Date().toISOString(),
        agentId: this.agentId
      }
    });
  }

  /**
   * 生成分层内容
   */
  private generateLayers(content: string): { L0?: string; L1?: string; L2: string } {
    const lines = content.split("\n");
    const L2 = content;

    // L1: 取前 2000 个字符或前 50 行
    let L1 = content.slice(0, 2000);
    if (lines.length > 50) {
      L1 = lines.slice(0, 50).join("\n");
    }

    // L0: 提取标题或生成一句话摘要
    let L0 = "";
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      L0 = titleMatch[1].slice(0, 100);
    } else {
      L0 = content.slice(0, 100).replace(/\n/g, " ") + "...";
    }

    return { L0, L1, L2 };
  }

  /**
   * 探测 Embedding 可用性
   */
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const health = await this.client.health();
      return {
        ok: health.status === "healthy",
        error: health.status === "healthy" ? undefined : `Status: ${health.status}`
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 探测向量搜索可用性
   */
  async probeVectorAvailability(): Promise<boolean> {
    const health = await this.client.health();
    return health.status === "healthy";
  }

  /**
   * 关闭管理器
   */
  async close(): Promise<void> {
    this.closed = true;
    this.logger?.info("OpenVikingMemoryManager closed");
  }

  /**
   * 推断记忆来源
   */
  private inferSource(uri: string): MemorySource {
    if (uri.includes("/sessions/")) return "sessions";
    return "memory";
  }
}
