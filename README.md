# OpenClaw Memory Plugin for OpenViking

Use OpenViking as the OpenClaw memory backend, exposing `memory_search` and `memory_get` tools.

## Current Status

- Plugin ID: `openclaw-memory-openviking`
- npm package: `@kevinzhow/openclaw-memory-openviking`
- OpenClaw compatibility: `>=2026.2.15`
- Default OpenViking endpoint used in development: `http://127.0.0.1:1933`

## Features

- Search via OpenViking: `POST /api/v1/search/find` or `POST /api/v1/search/search`
- Read content via OpenViking: `GET /api/v1/content/read`, `GET /api/v1/content/overview`
- Sync local memory files to OpenViking using `POST /api/v1/resources` + `POST /api/v1/fs/mkdir` + `POST /api/v1/fs/mv`
- Automatically falls back to local file reads when OpenViking reads fail

## Installation

### Option 1: npm

```bash
npm install @kevinzhow/openclaw-memory-openviking
```

### Option 2: local development

```bash
git clone https://github.com/clawd20130/openclaw-memory-openviking.git
cd openclaw-memory-openviking
npm install
npm run build
```

## OpenClaw Configuration

```json5
{
  plugins: {
    enabled: true,
    slots: {
      memory: "openclaw-memory-openviking"
    },
    load: {
      // Useful for local development
      paths: ["/path/to/openviking-memory-plugin"]
    },
    entries: {
      "openclaw-memory-openviking": {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:1933",
          apiKey: "optional-api-key",

          // Optional: defaults to viking://resources/openclaw/{agentId}
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

## Configuration Reference

- `baseUrl`: OpenViking HTTP endpoint (required).
- `apiKey`: optional API key when auth is enabled.
- `uriBase`: resource root URI, supports `{agentId}` placeholder.
- `tieredLoading`: when `true`, `memory_get` prefers `overview` when no line range is requested.
- `sync.interval`: periodic sync interval (for example `30s`, `5m`, `1h`, `1d`).
- `sync.onBoot`: run a sync immediately after plugin startup.
- `sync.extraPaths`: additional files/directories to sync (workspace-relative; directories are scanned recursively for `.md`).
- `sync.waitForProcessing`: wait for OpenViking processing queue to drain after sync.
- `sync.waitTimeoutSec`: wait timeout in seconds.
- `search.mode`: `find` (default) or `search` (session-aware).
- `search.defaultLimit`: default max result count.
- `search.scoreThreshold`: minimum score threshold.
- `search.targetUri`: restrict search scope.
- `server.enabled`: whether plugin auto-starts an OpenViking process.
- `server.venvPath`: required when `server.enabled=true`.

## Default Path Mapping

Default root: `viking://resources/openclaw/{agentId}/memory-sync`

Built-in mappings:

- `MEMORY.md` -> `.../root/MEMORY`
- `SOUL.md` -> `.../root/SOUL`
- `USER.md` -> `.../root/USER`
- `AGENTS.md` -> `.../root/AGENTS`
- `TOOLS.md` -> `.../root/TOOLS`
- `IDENTITY.md` -> `.../root/IDENTITY`
- `BOOTSTRAP.md` -> `.../root/BOOTSTRAP`
- `memory/YYYY-MM-DD.md` -> `.../memory/{date}`
- `skills/*/SKILL.md` -> `.../skills/{name}/SKILL`
- other files -> `.../files/{path}`

## Validation

Verify OpenViking health:

```bash
curl -sS http://127.0.0.1:1933/health
```

Verify OpenClaw loaded this plugin:

```bash
openclaw plugins info openclaw-memory-openviking --json
```

Expected output includes:

- `"status": "loaded"`
- `"toolNames": ["memory_search", "memory_get"]`

## Development

```bash
npm run build
npm test
```

Test suite includes:

- `tests/client.test.ts`
- `tests/mapper.test.ts`
- `tests/plugin.test.ts`
- `tests/manager.test.ts`

## Troubleshooting

### 1) plugin id mismatch

Make sure your slot and entry use the same plugin ID:

- `plugins.slots.memory = "openclaw-memory-openviking"`
- `plugins.entries["openclaw-memory-openviking"]`

### 2) `baseUrl is required`

`plugins.entries["openclaw-memory-openviking"].config.baseUrl` is missing.

### 3) `connection refused` to port `1933`

OpenViking is not running, or host/port does not match configuration.

### 4) `plugin path not found: ~/.openclaw/plugins`

Ensure each path listed in `plugins.load.paths` exists on disk, or remove unused paths.

### 5) `memory_get` falls back and then says local file not found

If the call context does not provide a valid `workspaceDir`, local fallback reads from the plugin process working directory. Run in a normal OpenClaw agent/session context, or ensure the target file exists in the current working directory.

## License

MIT
