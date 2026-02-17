/**
 * 路径 ↔ OpenViking URI 映射器
 */

import * as path from "path";
import type { PathMappingConfig } from "./types.js";

export interface PathMapping {
  localPath: string;
  vikingUriTemplate: string;
  pattern?: RegExp;
  extractParams?: (path: string) => Record<string, string> | null;
}

export interface PathMapperOptions {
  mappings?: PathMappingConfig;
  uriBase?: string;
  agentId?: string;
}

export class PathMapper {
  private mappings: PathMapping[] = [];
  private customMappings: Record<string, string> = {};
  private readonly uriBase: string;
  private readonly rootPrefix: string;
  private readonly stagingUri: string;

  constructor(options?: PathMapperOptions | PathMappingConfig) {
    const normalizedOptions = this.normalizeOptions(options);
    this.uriBase = this.resolveUriBase(normalizedOptions.uriBase, normalizedOptions.agentId);
    this.rootPrefix = `${this.uriBase}/memory-sync`;
    this.stagingUri = `${this.rootPrefix}/_staging`;
    this.setupDefaultMappings();
    if (normalizedOptions.mappings) {
      this.customMappings = normalizedOptions.mappings;
    }
  }

  /**
   * 设置默认映射规则
   */
  private setupDefaultMappings(): void {
    const root = this.rootPrefix;

    // 精确匹配
    this.mappings.push(
      { localPath: "MEMORY.md", vikingUriTemplate: `${root}/root/MEMORY` },
      { localPath: "SOUL.md", vikingUriTemplate: `${root}/root/SOUL` },
      { localPath: "USER.md", vikingUriTemplate: `${root}/root/USER` },
      { localPath: "AGENTS.md", vikingUriTemplate: `${root}/root/AGENTS` },
      { localPath: "TOOLS.md", vikingUriTemplate: `${root}/root/TOOLS` },
      { localPath: "IDENTITY.md", vikingUriTemplate: `${root}/root/IDENTITY` },
      { localPath: "BOOTSTRAP.md", vikingUriTemplate: `${root}/root/BOOTSTRAP` }
    );

    // 日期文件: memory/2025-06-18.md → .../memory/2025-06-18
    this.mappings.push({
      localPath: "memory/*.md",
      vikingUriTemplate: `${root}/memory/{date}`,
      pattern: /^memory\/(\d{4}-\d{2}-\d{2})\.md$/,
      extractParams: (path) => {
        const match = path.match(/^memory\/(\d{4}-\d{2}-\d{2})\.md$/);
        return match ? { date: match[1] } : null;
      }
    });

    // Skill 文件: skills/*/SKILL.md → viking://agent/skills/{name}
    this.mappings.push({
      localPath: "skills/*/SKILL.md",
      vikingUriTemplate: `${root}/skills/{name}/SKILL`,
      pattern: /^skills\/([^/]+)\/SKILL\.md$/,
      extractParams: (path) => {
        const match = path.match(/^skills\/([^/]+)\/SKILL\.md$/);
        return match ? { name: match[1] } : null;
      }
    });

    // 通用 memory 文件: memory/*.md → viking://user/memories/misc/{filename}
    this.mappings.push({
      localPath: "memory/*",
      vikingUriTemplate: `${root}/memory/misc/{filename}`,
      pattern: /^memory\/(.+)\.md$/,
      extractParams: (path) => {
        const match = path.match(/^memory\/(.+)\.md$/);
        return match ? { filename: match[1] } : null;
      }
    });

    // Skills 子目录: skills/*/data/* → viking://agent/skills/{name}/data/{filename}
    this.mappings.push({
      localPath: "skills/*/data/*",
      vikingUriTemplate: `${root}/skills/{name}/data/{filename}`,
      pattern: /^skills\/([^/]+)\/data\/(.+)$/,
      extractParams: (path) => {
        const match = path.match(/^skills\/([^/]+)\/data\/(.+)$/);
        return match ? { name: match[1], filename: match[2] } : null;
      }
    });

    // 其他文件: * → viking://user/files/{path}
    this.mappings.push({
      localPath: "*",
      vikingUriTemplate: `${root}/files/{path}`,
      pattern: /^(.+)$/,
      extractParams: (value) => {
        const clean = value.replace(/^\/+/, "").replace(/\.md$/i, "");
        return { path: clean };
      }
    });
  }

  /**
   * 本地路径 → Viking 目录 URI（根节点）
   */
  toVikingUri(localPath: string): string {
    const normalizedPath = this.normalizeLocalPath(localPath);

    // 优先检查自定义映射
    if (this.customMappings[normalizedPath]) {
      return this.normalizeVikingUri(this.customMappings[normalizedPath]);
    }

    // 按顺序匹配规则
    for (const mapping of this.mappings) {
      if (mapping.pattern) {
        const params = mapping.extractParams?.(normalizedPath);
        if (params) {
          return this.replaceParams(mapping.vikingUriTemplate, params);
        }
      } else if (mapping.localPath === normalizedPath) {
        return mapping.vikingUriTemplate;
      }
    }

    // 兜底
    return `${this.rootPrefix}/files/${normalizedPath.replace(/\.md$/i, "")}`;
  }

  /**
   * 本地路径 → Viking 文件 URI（实际 read 读取路径）
   */
  toContentUri(localPath: string): string {
    const rootUri = this.toVikingUri(localPath);
    const stem = this.toStem(localPath);
    return `${rootUri}/${stem}.md`;
  }

  /**
   * 本地路径 → 导入目标父目录 URI
   */
  toTargetParentUri(localPath: string): string {
    const rootUri = this.toVikingUri(localPath);
    const idx = rootUri.lastIndexOf("/");
    if (idx <= "viking://".length) {
      return rootUri;
    }
    return rootUri.slice(0, idx);
  }

  /**
   * 同步暂存目录
   */
  getStagingUri(): string {
    return this.stagingUri;
  }

  /**
   * 同步根前缀
   */
  getRootPrefix(): string {
    return this.rootPrefix;
  }

  /**
   * Viking URI → 本地路径（近似逆映射）
   */
  fromVikingUri(vikingUri: string): string {
    const normalizedUri = this.normalizeVikingUri(vikingUri);

    // 优先检查反向自定义映射
    for (const [localPath, uri] of Object.entries(this.customMappings)) {
      const normalizedCustomUri = this.normalizeVikingUri(uri);
      if (
        normalizedCustomUri === normalizedUri ||
        normalizedUri.startsWith(`${normalizedCustomUri}/`)
      ) {
        return localPath;
      }
    }

    // 默认映射逆解析
    if (normalizedUri.startsWith(`${this.rootPrefix}/`)) {
      const rel = normalizedUri.slice(`${this.rootPrefix}/`.length).replace(/^\/+/, "");
      if (!rel) {
        return "MEMORY.md";
      }

      const relNoLeaf = rel.replace(/\/([^/]+)\.md$/i, "");
      const parts = relNoLeaf.split("/").filter(Boolean);

      if (parts.length >= 2 && parts[0] === "root") {
        return `${parts[1]}.md`;
      }

      if (parts.length >= 2 && parts[0] === "memory") {
        if (parts[1] === "misc" && parts[2]) {
          return `memory/${parts.slice(2).join("/")}.md`;
        }
        return `memory/${parts[1]}.md`;
      }

      if (parts.length >= 3 && parts[0] === "skills") {
        const skillName = parts[1];
        if (parts[2] === "SKILL") {
          return `skills/${skillName}/SKILL.md`;
        }
        if (parts[2] === "data") {
          return `skills/${skillName}/data/${parts.slice(3).join("/")}`;
        }
      }

      if (parts.length >= 2 && parts[0] === "files") {
        const raw = parts.slice(1).join("/");
        return raw.endsWith(".md") ? raw : `${raw}.md`;
      }
    }

    // 兜底: 移除前缀
    return normalizedUri.replace(/^viking:\/\//, "");
  }

  /**
   * 替换模板参数
   */
  private replaceParams(template: string, params: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      return params[key] ?? match;
    });
  }

  /**
   * 获取所有映射规则（用于调试）
   */
  getMappings(): PathMapping[] {
    return [...this.mappings];
  }

  /**
   * 添加自定义映射
   */
  addCustomMapping(localPath: string, vikingUri: string): void {
    this.customMappings[this.normalizeLocalPath(localPath)] = this.normalizeVikingUri(vikingUri);
  }

  private normalizeOptions(options?: PathMapperOptions | PathMappingConfig): PathMapperOptions {
    if (!options) {
      return {};
    }
    const hasKnownField =
      typeof options === "object" &&
      options !== null &&
      ("mappings" in options || "uriBase" in options || "agentId" in options);

    if (hasKnownField) {
      return options as PathMapperOptions;
    }
    return { mappings: options as PathMappingConfig };
  }

  private resolveUriBase(uriBase?: string, agentId?: string): string {
    const raw = (uriBase ?? "viking://resources/openclaw/{agentId}").trim().replace(/\/+$/, "");
    const id = (agentId ?? "main").trim() || "main";
    if (raw.includes("{agentId}")) {
      return raw.replace(/\{agentId\}/g, encodeURIComponent(id));
    }
    return `${raw}/${encodeURIComponent(id)}`;
  }

  private normalizeLocalPath(input: string): string {
    return input.replace(/\\/g, "/").replace(/^\/+/, "");
  }

  private normalizeVikingUri(uri: string): string {
    return uri.replace(/\/+$/, "");
  }

  private toStem(localPath: string): string {
    const normalized = this.normalizeLocalPath(localPath);
    const ext = path.extname(normalized);
    const base = path.basename(normalized, ext || undefined);
    return this.sanitizeSegment(base);
  }

  private sanitizeSegment(value: string): string {
    const stripped = value.replace(/[^\w\u4e00-\u9fff\s-]/g, "");
    const collapsed = stripped.replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
    return collapsed || "content";
  }
}
