/**
 * 路径 ↔ OpenViking URI 映射器
 */

import type { OpenVikingPluginConfig } from "./types.js";

export interface PathMapping {
  localPath: string;
  vikingUri: string;
  pattern?: RegExp;
  extractParams?: (path: string) => Record<string, string> | null;
}

export class PathMapper {
  private mappings: PathMapping[] = [];
  private customMappings: Record<string, string> = {};

  constructor(config?: OpenVikingPluginConfig["mappings"]) {
    this.setupDefaultMappings();
    if (config) {
      this.customMappings = config;
    }
  }

  /**
   * 设置默认映射规则
   */
  private setupDefaultMappings(): void {
    // 精确匹配
    this.mappings.push(
      { localPath: "MEMORY.md", vikingUri: "viking://user/memories/longterm" },
      { localPath: "SOUL.md", vikingUri: "viking://user/preferences/persona" },
      { localPath: "USER.md", vikingUri: "viking://user/preferences/profile" },
      { localPath: "AGENTS.md", vikingUri: "viking://agent/config/agents" },
      { localPath: "TOOLS.md", vikingUri: "viking://user/preferences/tools" },
      { localPath: "IDENTITY.md", vikingUri: "viking://user/preferences/identity" },
      { localPath: "BOOTSTRAP.md", vikingUri: "viking://agent/config/bootstrap" }
    );

    // 日期文件: memory/2025-06-18.md → viking://user/memories/daily/2025-06-18
    this.mappings.push({
      localPath: "memory/*.md",
      vikingUri: "viking://user/memories/daily/{date}",
      pattern: /^memory\/(\d{4}-\d{2}-\d{2})\.md$/,
      extractParams: (path) => {
        const match = path.match(/^memory\/(\d{4}-\d{2}-\d{2})\.md$/);
        return match ? { date: match[1] } : null;
      }
    });

    // Skill 文件: skills/*/SKILL.md → viking://agent/skills/{name}
    this.mappings.push({
      localPath: "skills/*/SKILL.md",
      vikingUri: "viking://agent/skills/{name}",
      pattern: /^skills\/([^/]+)\/SKILL\.md$/,
      extractParams: (path) => {
        const match = path.match(/^skills\/([^/]+)\/SKILL\.md$/);
        return match ? { name: match[1] } : null;
      }
    });

    // 通用 memory 文件: memory/*.md → viking://user/memories/misc/{filename}
    this.mappings.push({
      localPath: "memory/*",
      vikingUri: "viking://user/memories/misc/{filename}",
      pattern: /^memory\/(.+)\.md$/,
      extractParams: (path) => {
        const match = path.match(/^memory\/(.+)\.md$/);
        return match ? { filename: match[1] } : null;
      }
    });

    // Skills 子目录: skills/*/data/* → viking://agent/skills/{name}/data/{filename}
    this.mappings.push({
      localPath: "skills/*/data/*",
      vikingUri: "viking://agent/skills/{name}/data/{filename}",
      pattern: /^skills\/([^/]+)\/data\/(.+)$/,
      extractParams: (path) => {
        const match = path.match(/^skills\/([^/]+)\/data\/(.+)$/);
        return match ? { name: match[1], filename: match[2] } : null;
      }
    });

    // 其他文件: * → viking://user/files/{path}
    this.mappings.push({
      localPath: "*",
      vikingUri: "viking://user/files/{path}",
      pattern: /^(.*)$/,
      extractParams: (path) => ({ path })
    });
  }

  /**
   * 本地路径 → Viking URI
   */
  toVikingUri(localPath: string): string {
    // 优先检查自定义映射
    if (this.customMappings[localPath]) {
      return this.customMappings[localPath];
    }

    // 按顺序匹配规则
    for (const mapping of this.mappings) {
      if (mapping.pattern) {
        const params = mapping.extractParams?.(localPath);
        if (params) {
          return this.replaceParams(mapping.vikingUri, params);
        }
      } else if (mapping.localPath === localPath) {
        return mapping.vikingUri;
      }
    }

    // 兜底
    return `viking://user/files/${localPath}`;
  }

  /**
   * Viking URI → 本地路径
   */
  fromVikingUri(vikingUri: string): string {
    // 优先检查反向自定义映射
    for (const [localPath, uri] of Object.entries(this.customMappings)) {
      if (uri === vikingUri) return localPath;
    }

    // 按顺序反向匹配
    for (const mapping of this.mappings) {
      if (mapping.pattern) {
        // 构建反向映射
        const reversed = this.reverseMapping(vikingUri, mapping);
        if (reversed) return reversed;
      } else if (mapping.vikingUri === vikingUri) {
        return mapping.localPath;
      }
    }

    // 兜底: 移除前缀
    const prefixes = [
      "viking://user/files/",
      "viking://user/memories/",
      "viking://user/preferences/",
      "viking://agent/config/",
      "viking://agent/skills/"
    ];
    for (const prefix of prefixes) {
      if (vikingUri.startsWith(prefix)) {
        return vikingUri.slice(prefix.length);
      }
    }

    return vikingUri.replace("viking://", "");
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
   * 反向映射: 从 URI 提取参数并构建本地路径
   */
  private reverseMapping(vikingUri: string, mapping: PathMapping): string | null {
    if (!mapping.pattern || !mapping.extractParams) return null;

    // 构建 URI 的正则
    const uriTemplate = mapping.vikingUri;
    const paramNames = [...uriTemplate.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    
    // 转义特殊字符，保留占位符
    let uriPattern = uriTemplate
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\{(\w+)\\\}/g, "([^/]+)");
    
    const regex = new RegExp(`^${uriPattern}$`);
    const match = vikingUri.match(regex);
    
    if (!match) return null;

    // 构建参数对象
    const params: Record<string, string> = {};
    paramNames.forEach((name, i) => {
      params[name] = match[i + 1];
    });

    // 反向替换本地路径模板
    return this.replaceParams(mapping.localPath, params);
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
    this.customMappings[localPath] = vikingUri;
  }
}
