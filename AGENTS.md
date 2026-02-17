# AGENTS.md

本文件面向在本仓库工作的开发代理（human/AI）。目标是减少回归、保证插件与 OpenClaw/OpenViking API 一致。

## 1. 仓库定位

- 项目：OpenClaw memory 插件（OpenViking 后端）。
- 运行时注册工具：`memory_search`、`memory_get`。
- 插件 canonical id：`openclaw-memory-openviking`。
- npm 包名：`@kevinzhow/openclaw-memory-openviking`。

## 2. 关键一致性约束

以下字段必须保持一致，否则容易出现加载警告或配置失效：

- `src/index.ts` 中 `plugin.id`
- `openclaw.plugin.json` 中 `id`
- 文档和示例中的 `plugins.slots.memory`
- 文档和示例中的 `plugins.entries.<id>`

当前正确值：`openclaw-memory-openviking`。

## 3. 核心代码结构

- `src/index.ts`：插件入口、config 解析、工具注册、周期同步、关闭清理。
- `src/client.ts`：OpenViking HTTP 客户端与错误包装。
- `src/manager.ts`：`MemorySearchManager` 实现（search/read/sync/probe）。
- `src/mapper.ts`：本地路径与 OpenViking URI 的映射规则。
- `src/types.ts`：插件配置与 OpenViking API 类型。
- `openclaw.plugin.json`：OpenClaw manifest（schema + uiHints）。

## 4. OpenViking API 约束

当前实现依赖以下接口（变更时必须同步代码和测试）：

- `GET /health`
- `GET /api/v1/system/status`
- `POST /api/v1/search/find`
- `POST /api/v1/search/search`
- `GET /api/v1/content/read`
- `GET /api/v1/content/overview`
- `GET /api/v1/content/abstract`
- `POST /api/v1/resources`
- `DELETE /api/v1/fs`
- `POST /api/v1/fs/mv`
- `POST /api/v1/system/wait`

## 5. 配置模型约束

允许的配置字段以 `src/index.ts` 的 `configSchema` 与 `openclaw.plugin.json` 为准。

注意：不要在文档或示例中引入已删除/不存在字段（例如 `autoLayering`、`debounceMs`、`search.mode=hybrid`）。

## 6. 开发与验证流程

安装与构建：

```bash
npm install
npm run build
```

测试：

```bash
npm test
```

测试必须全部通过（当前 13 tests）。

## 7. 集成冒烟测试（本地 OpenViking）

默认使用：`http://127.0.0.1:1933`。

建议最小验证：

```bash
curl -sS http://127.0.0.1:1933/health
openclaw plugins info openclaw-memory-openviking --json
```

成功标准：

- OpenViking 健康检查返回 `ok`
- 插件状态为 `loaded`
- `toolNames` 包含 `memory_search`、`memory_get`

## 8. 修改规则（Do/Don’t）

Do:

- 修改 config 结构时，至少同步：`src/types.ts`、`src/index.ts`、`openclaw.plugin.json`、`README.md`、相关 tests。
- 修改 API 调用时，补充/更新 `tests/client.test.ts` 和 `tests/plugin.test.ts`。
- 保持 TypeScript strict 兼容，不引入 `any` 泄漏。

Don’t:

- 不要只改 manifest 或只改 runtime id。
- 不要在示例里写与 schema 不一致的字段。
- 不要跳过测试就提交对外行为变更。

## 9. 提交前检查清单

- `npm run build` 成功。
- `npm test` 全通过。
- `openclaw.plugin.json` 与 `src/index.ts` 的 id 一致。
- README 配置片段可直接运行，字段与 schema 一致。
