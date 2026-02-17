# Examples

## Install

```bash
npm install -g @kevinzhow/openclaw-memory-openviking
```

## Basic Configuration

```json5
// ~/.openclaw/openclaw.config.json5
{
  plugins: {
    slots: {
      memory: "openclaw-memory-openviking"
    },
    entries: {
      "openclaw-memory-openviking": {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:1933",
          sync: {
            extraPaths: ["notes", "docs/memory"]
          }
        }
      }
    }
  }
}
```

## Custom Path Mappings

```json5
{
  plugins: {
    slots: { memory: "openclaw-memory-openviking" },
    entries: {
      "openclaw-memory-openviking": {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:1933",
          mappings: {
            // Custom mappings
            "work-notes.md": "viking://work/notes",
            "projects/*/README.md": "viking://projects/{name}/readme"
          }
        }
      }
    }
  }
}
```

## Environment Variables

```bash
# ~/.bashrc or ~/.zshrc
export OPENVIKING_URL="http://127.0.0.1:1933"
export OPENVIKING_API_KEY="your-api-key"
```

```json5
{
  plugins: {
    entries: {
      "openclaw-memory-openviking": {
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

## Multi-agent Configuration

```json5
{
  agents: {
    defaults: {
      // All agents use OpenViking memory by default
    },
    entries: {
      "special-agent": {
        // This agent uses built-in memory
        plugins: {
          slots: { memory: "none" }
        }
      }
    }
  }
}
```
