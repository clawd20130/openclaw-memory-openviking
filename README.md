# OpenClaw Memory Plugin for OpenViking

将 [OpenViking](https://github.com/volcengine/OpenViking) 作为 OpenClaw 的记忆后端，提供分层上下文管理和自我进化能力。

## 特性

- 🔗 **无缝集成** - 实现 OpenClaw `MemorySearchManager` 接口，零成本切换
- 📚 **分层加载** - L0/L1/L2 三层内容，按需加载节省 token
- 📁 **文件系统范式** - 利用 OpenViking 的目录层级提升检索效果
- 🔄 **自我进化** - 自动压缩对话、提取长期记忆
- 🔍 **混合检索** - 语义搜索 + 目录结构 + 文件名匹配

## 安装

```bash
# 方法1: 全局安装
npm install -g @kevinzhow/openclaw-memory-openviking

# 方法2: 本地路径加载
git clone https://github.com/kevinzhow/openclaw-memory-openviking.git
cd openclaw-memory-openviking
npm install && npm run build
```

## 配置

```json5
// openclaw.config.json5
{
  plugins: {
    enabled: true,
    slots: {
      memory: "openviking"  // 切换到 OpenViking 后端
    },
    load: {
      paths: ["~/.openclaw/plugins"]  // 如果使用本地路径
    },
    entries: {
      openviking: {
        enabled: true,
        config: {
          // OpenViking 服务地址
          baseUrl: "http://127.0.0.1:1933",
          
          // 可选: API Key
          apiKey: "your-api-key",
          
          // 路径映射规则
          mappings: {
            "MEMORY.md": "viking://user/memories/longterm",
            "SOUL.md": "viking://user/preferences/persona",
            "USER.md": "viking://user/preferences/profile",
            "AGENTS.md": "viking://agent/config/agents",
            "memory/*.md": "viking://user/memories/daily/{date}",
            "skills/*/SKILL.md": "viking://agent/skills/{name}"
          },
          
          // 分层策略
          tieredLoading: true,
          autoLayering: true,
          
          // 同步配置
          sync: {
            interval: "5m",
            onBoot: true,
            debounceMs: 5000
          }
        }
      }
    }
  }
}
```

## 先决条件

1. **部署 OpenViking 服务**
   ```bash
   git clone https://github.com/volcengine/OpenViking.git
   cd OpenViking
   # 按照官方文档部署服务
   docker-compose up -d
   ```

2. **确保 OpenClaw 版本支持插件**
   - 需要 OpenClaw >= 0.x（支持 memory slot 的版本）

## 路径映射

| 本地文件 | OpenViking URI |
|---------|---------------|
| `MEMORY.md` | `viking://user/memories/longterm` |
| `memory/2025-06-18.md` | `viking://user/memories/daily/2025-06-18` |
| `SOUL.md` | `viking://user/preferences/persona` |
| `USER.md` | `viking://user/preferences/profile` |
| `AGENTS.md` | `viking://agent/config/agents` |
| `skills/*/SKILL.md` | `viking://agent/skills/{name}` |

## 工作原理

```
┌─────────────────────────────────────────┐
│         OpenClaw Session                │
│   memory_search / memory_get            │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│   OpenVikingMemoryManager (本插件)       │
│   - 路径 ↔ URI 映射                      │
│   - HTTP 调用 OpenViking API            │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│   OpenViking Server                     │
│   - 分层存储 (L0/L1/L2)                 │
│   - 混合检索                            │
│   - 自我进化                            │
└─────────────────────────────────────────┘
```

## 开发

```bash
# 克隆仓库
git clone https://github.com/kevinzhow/openclaw-memory-openviking.git
cd openclaw-memory-openviking

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 类型检查
npm run typecheck
```

## 与 QMD 的对比

| 特性 | QMD | OpenViking (本插件) |
|-----|-----|-------------------|
| 部署方式 | 子进程 CLI | HTTP 服务 |
| 存储模型 | 平面向量索引 | 文件系统层级 |
| 分层加载 | ❌ | ✅ L0/L1/L2 |
| 目录感知 | 弱 | 强 |
| 自我进化 | ❌ | ✅ |
| 可视化 | ❌ | ✅ 检索轨迹 |
| 依赖 | Bun + SQLite | Docker + Python |

## 许可证

MIT © Kevin Zhow

## 相关链接

- [OpenClaw](https://github.com/openclaw/openclaw)
- [OpenViking](https://github.com/volcengine/OpenViking)
- [QMD](https://github.com/tobi/qmd)
