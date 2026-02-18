# OpenClaw Memory Plugin for OpenViking

Use OpenViking as the OpenClaw memory backend, exposing `memory_search` and `memory_get` tools.

## Current Status

- Plugin ID: `openclaw-memory-openviking`
- npm package: `@kevinzhow/openclaw-memory-openviking`
- OpenClaw compatibility: `>=2026.2.15`
- Default OpenViking endpoint used in development: `http://127.0.0.1:1933`

## Features

- Search via OpenViking: `POST /api/v1/search/search` or `POST /api/v1/search/find`
- Read content via OpenViking: `GET /api/v1/content/read`, `GET /api/v1/content/overview`
- Sync local memory files to OpenViking using `GET /api/v1/fs/stat` + `POST /api/v1/resources` (with `POST /api/v1/fs/mkdir` / `DELETE /api/v1/fs` only when needed)
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
            mode: "search", // "search" | "find"
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

### Top-level fields

- `baseUrl` (required): OpenViking HTTP endpoint.
- `apiKey` (optional): API key used for `X-API-Key`/`Authorization` when auth is enabled.
- `uriBase` (optional): root URI for synced content. Default is `viking://resources/openclaw/{agentId}`.
- `tieredLoading` (default: `true`): for `memory_get` without line range, try `overview` first and fall back to full `read`.
- `mappings` (optional): custom local-path -> OpenViking URI mapping overrides for specific files.

### `search` fields

- `search.mode` (default: `search`):
  - `search`: session-aware retrieval via `/api/v1/search/search`; recommended default when session context is available.
  - `find`: stateless retrieval via `/api/v1/search/find`; useful for low-latency or strictly stateless lookup.
- `search.defaultLimit` (default: `6`): default result count when `memory_search.maxResults` is not passed.
- `search.scoreThreshold` (default: `0`, range: `0..1`): minimum score to keep a result.
- `search.targetUri` (optional): restrict search scope to one URI subtree.

### `sync` fields

- Sync is incremental and persisted: each run scans local candidates, then only upserts files whose local fingerprint changed (`size + mtime`), and removes remote entries for files deleted locally. Snapshot state is stored at `<workspace>/.openclaw/plugins/openviking-memory/{agentId}.sync-state.json`.
- Sync execution is single-flight per manager: if a sync is already running, later triggers join the in-flight run instead of starting a parallel duplicate sync.
- Snapshot recovery optimization: when local snapshot is missing, the plugin attempts to adopt matching remote resources (content hash check) before deciding to re-import.
- Crash-safe recovery: if the previous sync exited unexpectedly (or finished with errors), the next run is forced to a full recovery sync.
- `sync.ovConfigPath` (optional): path to `ov.conf`. If this file fingerprint changes, the next sync is forced to full rebuild (re-upsert all files). Relative paths are resolved from workspace root.
- `sync.interval` (default: disabled): periodic sync interval, supported format is `^\\d+[smhd]$` (examples: `30s`, `5m`, `1h`, `1d`).
- `sync.onBoot` (default: `true`): trigger one sync after plugin startup.
- `sync.extraPaths` (optional): extra files/directories to sync. Paths are workspace-relative; directories are scanned recursively for `.md`.
- `sync.waitForProcessing` (default: `false`): after syncing, wait for OpenViking queue processing to finish.
- `sync.waitTimeoutSec` (optional): timeout used by `waitForProcessing`.

### `server` fields (optional)

If `server.enabled` is omitted/false, the plugin assumes OpenViking is already running at `baseUrl`.

- `server.enabled`: auto-start and auto-stop OpenViking from this plugin process.
- `server.venvPath` (required when `server.enabled=true`): Python venv root containing `openviking`.
- `server.dataDir` (optional): passed as `--data-dir`.
- `server.host` (default: `127.0.0.1`): host for auto-started OpenViking.
- `server.port` (default: `1933`): port for auto-started OpenViking.
- `server.startupTimeoutMs` (default: `30000`): startup health-check timeout.
- `server.env` (optional): extra environment variables for OpenViking process.

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
