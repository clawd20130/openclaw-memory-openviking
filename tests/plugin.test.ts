import assert from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import plugin from "../src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createFakeApi(params: {
  pluginConfig: Record<string, unknown>;
  toolRegistrations: Array<{ tool: unknown; opts?: unknown }>;
}) {
  const api = {
    id: "openclaw-memory-openviking",
    name: "OpenViking Memory",
    version: "test",
    description: "test",
    source: "test",
    config: {},
    pluginConfig: params.pluginConfig,
    runtime: {},
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    },
    registerTool: (tool: unknown, opts?: unknown) => {
      params.toolRegistrations.push({ tool, opts });
    },
    registerHook: () => undefined,
    registerHttpHandler: () => undefined,
    registerHttpRoute: () => undefined,
    registerChannel: () => undefined,
    registerGatewayMethod: () => undefined,
    registerCli: () => undefined,
    registerService: () => undefined,
    registerProvider: () => undefined,
    registerCommand: () => undefined,
    resolvePath: (input: string) => input,
    on: () => undefined
  } as unknown as OpenClawPluginApi;
  return api;
}

describe("openviking plugin", () => {
  it("registers memory_search and memory_get tools and executes them", async () => {
    const toolRegistrations: Array<{ tool: unknown; opts?: unknown }> = [];
    const api = createFakeApi({
      pluginConfig: {
        baseUrl: "http://127.0.0.1:1933",
        sync: { onBoot: false }
      },
      toolRegistrations
    });

    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-plugin-test-"));
    await writeFile(path.join(workspace, "MEMORY.md"), "# Memory\nline1\nline2\n", "utf-8");

    globalThis.fetch = ((async (url: string | URL | Request) => {
      const urlText = String(url);
      if (urlText.endsWith("/api/v1/search/find")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: {
              memories: [],
              resources: [
                {
                  uri: "viking://resources/openclaw/main/memory-sync/root/MEMORY",
                  context_type: "resource",
                  is_leaf: false,
                  abstract: "Memory summary",
                  score: 0.9
                }
              ],
              skills: [],
              total: 1
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlText.includes("/api/v1/content/read")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: "line1\nline2\nline3"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          status: "error",
          error: { code: "NOT_FOUND", message: `Unexpected URL: ${urlText}` }
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown) as typeof fetch;

    plugin.register?.(api);

    assert.strictEqual(toolRegistrations.length, 1);
    const factory = toolRegistrations[0]?.tool as ((ctx: Record<string, unknown>) => AnyAgentTool[]);
    const tools = factory({
      workspaceDir: workspace,
      agentId: "main",
      sessionKey: "agent:main:test"
    });

    const searchTool = tools.find((tool) => tool.name === "memory_search");
    const getTool = tools.find((tool) => tool.name === "memory_get");
    assert.ok(searchTool, "memory_search tool not found");
    assert.ok(getTool, "memory_get tool not found");

    const searchResult = (await searchTool!.execute("call-search", {
      query: "memory"
    })) as {
      details: { results: Array<{ path: string; snippet: string }> };
    };
    assert.strictEqual(searchResult.details.results.length, 1);
    assert.strictEqual(searchResult.details.results[0]?.path, "MEMORY.md");
    assert.ok(searchResult.details.results[0]?.snippet.includes("Memory summary"));

    const getResult = (await getTool!.execute("call-get", {
      path: "MEMORY.md",
      from: 2,
      lines: 1
    })) as {
      details: { path: string; text: string };
    };
    assert.strictEqual(getResult.details.path, "MEMORY.md");
    assert.strictEqual(getResult.details.text, "line2");
  });
});
