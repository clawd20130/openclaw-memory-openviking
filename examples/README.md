# 示例

## 基本配置

```json5
// ~/.openclaw/openclaw.config.json5
{
  plugins: {
    slots: {
      memory: "openviking"
    },
    entries: {
      openviking: {
        enabled: true,
        config: {
          baseUrl: "http://localhost:8080"
        }
      }
    }
  }
}
```

## 自定义路径映射

```json5
{
  plugins: {
    slots: { memory: "openviking" },
    entries: {
      openviking: {
        enabled: true,
        config: {
          baseUrl: "http://localhost:8080",
          mappings: {
            // 自定义映射
            "work-notes.md": "viking://work/notes",
            "projects/*/README.md": "viking://projects/{name}/readme"
          }
        }
      }
    }
  }
}
```

## 使用环境变量

```bash
# ~/.bashrc 或 ~/.zshrc
export OPENVIKING_URL="http://localhost:8080"
export OPENVIKING_API_KEY="your-api-key"
```

```json5
{
  plugins: {
    entries: {
      openviking: {
        enabled: true,
        config: {
          baseUrl: process.env.OPENVIKING_URL,
          apiKey: process.env.OPENVIKING_API_KEY
        }
      }
    }
  }
}
```

## 多 Agent 配置

```json5
{
  agents: {
    defaults: {
      // 所有 agent 默认使用 OpenViking
    },
    entries: {
      "special-agent": {
        // 这个 agent 使用内置 memory
        plugins: {
          slots: { memory: "none" }
        }
      }
    }
  }
}
```
