# AGENTS.md

This file is for development agents (human or AI) working in this repository. The goal is to reduce regressions and keep behavior aligned with OpenClaw and OpenViking APIs.

## 1. Repository Scope

- Project: OpenClaw memory plugin backed by OpenViking.
- Runtime tools: `memory_search`, `memory_get`.
- Canonical plugin ID: `openclaw-memory-openviking`.
- npm package name: `@kevinzhow/openclaw-memory-openviking`.

## 2. Critical Consistency Rules

The following fields must stay consistent to avoid load warnings or invalid config:

- `plugin.id` in `src/index.ts`
- `id` in `openclaw.plugin.json`
- `plugins.slots.memory` in docs/examples/config snippets
- `plugins.entries.<id>` in docs/examples/config snippets

Correct value: `openclaw-memory-openviking`.

## 3. Core Code Layout

- `src/index.ts`: plugin entry, config parsing, tool registration, periodic sync, shutdown handling.
- `src/client.ts`: OpenViking HTTP client and error wrapping.
- `src/manager.ts`: `MemorySearchManager` implementation (`search`, `readFile`, `sync`, probes).
- `src/mapper.ts`: local-path to OpenViking-URI mapping rules.
- `src/types.ts`: plugin config and OpenViking API types.
- `openclaw.plugin.json`: OpenClaw manifest (`configSchema` + `configUiHints`).

## 4. OpenViking API Contract

Current implementation depends on these endpoints. If any endpoint behavior changes, update code and tests together:

- `GET /health`
- `GET /api/v1/system/status`
- `POST /api/v1/search/find`
- `POST /api/v1/search/search`
- `GET /api/v1/content/read`
- `GET /api/v1/content/overview`
- `GET /api/v1/content/abstract`
- `POST /api/v1/resources`
- `POST /api/v1/fs/mkdir`
- `DELETE /api/v1/fs`
- `POST /api/v1/fs/mv`
- `POST /api/v1/system/wait`

## 5. Configuration Model Constraints

Allowed config fields are defined by `configSchema` in `src/index.ts` and `openclaw.plugin.json`.

Do not introduce removed/unsupported fields in docs or examples (for example `autoLayering`, `debounceMs`, `search.mode=hybrid`).

## 6. Build and Validation Workflow

Install and build:

```bash
npm install
npm run build
```

Run tests:

```bash
npm test
```

All tests must pass before shipping changes (currently 19 tests).

## 7. Local Integration Smoke Test (OpenViking)

Default endpoint: `http://127.0.0.1:1933`.

Minimal checks:

```bash
curl -sS http://127.0.0.1:1933/health
openclaw plugins info openclaw-memory-openviking --json
```

Success criteria:

- OpenViking health returns `ok`
- Plugin status is `loaded`
- `toolNames` contains `memory_search` and `memory_get`

## 8. Change Rules (Do / Don't)

Do:

- When changing config structure, update at least: `src/types.ts`, `src/index.ts`, `openclaw.plugin.json`, `README.md`, and related tests.
- When changing API calls, add or update tests in `tests/client.test.ts` and `tests/plugin.test.ts`.
- Keep TypeScript strict compatibility; do not leak `any`.

Don't:

- Do not update only the manifest ID or only runtime ID.
- Do not put schema-inconsistent fields in examples.
- Do not skip tests for externally visible behavior changes.

## 9. Pre-commit Checklist

- `npm run build` succeeds.
- `npm test` passes.
- `id` in `openclaw.plugin.json` matches `plugin.id` in `src/index.ts`.
- README config snippets are runnable and schema-consistent.
