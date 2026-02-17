# OpenClaw Memory Plugin for OpenViking

把 OpenViking 作为 OpenClaw 的 memory 插件，提供 `memory_search` 和 `memory_get` 两个工具。

## 当前状态

- 插件 id：`openclaw-memory-openviking`
- npm 包名：`@kevinzhow/openclaw-memory-openviking`
- 兼容 OpenClaw：`>=2026.2.15`
- 开发默认 OpenViking 地址：`http://127.0.0.1:1933`

## 功能

- 使用 OpenViking 检索：`/api/v1/search/find` 或 `/api/v1/search/search`
- 使用 OpenViking 读取：`/api/v1/content/read`、`/api/v1/content/overview`
- 支持本地记忆文件同步到 OpenViking：`/api/v1/resources` + `/api/v1/fs/mv`
- OpenViking 不可读时，`memory_get` 自动回退本地文件读取

## 安装

### 方式 1：npm

```bash
npm install @kevinzhow/openclaw-memory-openviking
```

### 方式 2：本地开发

```bash
git clone https://github.com/kevinzhow/openclaw-memory-openviking.git
cd openclaw-memory-openviking
npm install
npm run build
```

## OpenClaw 配置

```json5
{
  plugins: {
    enabled: true,
    slots: {
      memory: "openclaw-memory-openviking"
    },
    load: {
      // 本地开发时可用
      paths: ["/path/to/openviking-memory-plugin"]
    },
    entries: {
      "openclaw-memory-openviking": {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:1933",
          apiKey: "optional-api-key",

          // 可选：默认 viking://resources/openclaw/{agentId}
          uriBase: "viking://resources/openclaw/{agentId}",

          tieredLoading: true,

          sync: {
            interval: "5m",
            onBoot: true,
            extraPaths: ["notes", "docs/memory"],
            waitForProcessing: false,
            waitTimeoutSec: 60
          },

          search: {
            mode: "find", // "find" | "search"
            defaultLimit: 6,
            scoreThreshold: 0,
            targetUri: "viking://resources/openclaw/main/memory-sync"
          }
        }
      }
    }
  }
}
```

## 配置项说明

- `baseUrl`：OpenViking HTTP 地址，必填。
- `apiKey`：可选，若服务开启鉴权可填写。
- `uriBase`：资源根路径，支持 `{agentId}` 占位符。
- `tieredLoading`：`true` 时，`memory_get` 在未指定行号优先走 overview。
- `sync.interval`：周期同步间隔（例如 `30s`、`5m`、`1h`、`1d`）。
- `sync.onBoot`：插件加载后是否先做一次同步。
- `sync.extraPaths`：额外同步目录/文件（相对 workspace，目录会递归扫描 `.md`）。
- `sync.waitForProcessing`：同步后是否等待 OpenViking 队列完成。
- `sync.waitTimeoutSec`：等待超时时间（秒）。
- `search.mode`：`find`（默认）或 `search`（带 session 语义）。
- `search.defaultLimit`：默认返回条数。
- `search.scoreThreshold`：最小分数阈值。
- `search.targetUri`：限制检索范围。
- `server.enabled`：是否由插件自动拉起 OpenViking。
- `server.venvPath`：`server.enabled=true` 时必填。

## 默认路径映射

默认以 `viking://resources/openclaw/{agentId}/memory-sync` 为根，内置映射包括：

- `MEMORY.md` -> `.../root/MEMORY`
- `SOUL.md` -> `.../root/SOUL`
- `USER.md` -> `.../root/USER`
- `AGENTS.md` -> `.../root/AGENTS`
- `TOOLS.md` -> `.../root/TOOLS`
- `IDENTITY.md` -> `.../root/IDENTITY`
- `BOOTSTRAP.md` -> `.../root/BOOTSTRAP`
- `memory/YYYY-MM-DD.md` -> `.../memory/{date}`
- `skills/*/SKILL.md` -> `.../skills/{name}/SKILL`
- 其他文件 -> `.../files/{path}`

## 验证

先确认 OpenViking 服务可用：

```bash
curl -sS http://127.0.0.1:1933/health
```

确认 OpenClaw 成功加载插件：

```bash
openclaw plugins info openclaw-memory-openviking --json
```

输出里应包含：

- `"status": "loaded"`
- `"toolNames": ["memory_search", "memory_get"]`

## 开发

```bash
npm run build
npm test
```

测试包含：

- `tests/client.test.ts`
- `tests/mapper.test.ts`
- `tests/plugin.test.ts`

## 常见问题

### 1) plugin id mismatch

请确保配置里的 slot/entry 使用同一个 id：

- `plugins.slots.memory = "openclaw-memory-openviking"`
- `plugins.entries["openclaw-memory-openviking"]`

### 2) `baseUrl is required`

未配置 `plugins.entries["openclaw-memory-openviking"].config.baseUrl`。

### 3) `connection refused` 到 1933

OpenViking 服务未启动，或端口/地址不匹配。

### 4) `memory_get` 返回本地文件不存在

调用上下文缺少正确 `workspaceDir` 时会回退到插件进程当前目录读取本地文件。请在 OpenClaw 正常 agent/session 上下文里调用，或确保读取路径在当前工作目录存在。

## 许可证

MIT
