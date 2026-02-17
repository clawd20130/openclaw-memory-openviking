import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { OpenVikingClient, OpenVikingHttpError } from "../src/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenVikingClient", () => {
  it("should call find endpoint and unwrap result", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledInit = init;
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
                score: 0.88
              }
            ],
            skills: [],
            total: 1
          }
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as unknown) as typeof fetch;

    const client = new OpenVikingClient({
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "test-key"
    });

    const result = await client.find({
      query: "memory",
      limit: 3
    });

    assert.strictEqual(calledUrl, "http://127.0.0.1:1933/api/v1/search/find");
    assert.strictEqual(calledInit?.method, "POST");
    assert.strictEqual(
      (calledInit?.headers as Record<string, string>)["X-API-Key"],
      "test-key"
    );
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.resources[0]?.abstract, "Memory summary");
  });

  it("should parse raw health response", async () => {
    globalThis.fetch = ((async () => {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown) as typeof fetch;

    const client = new OpenVikingClient({
      baseUrl: "http://127.0.0.1:1933"
    });

    const health = await client.health();
    assert.strictEqual(health.status, "ok");
  });

  it("should call mkdir endpoint", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledInit = init;
      return new Response(
        JSON.stringify({
          status: "ok",
          result: {
            uri: "viking://resources/openclaw/main/memory-sync/root"
          }
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as unknown) as typeof fetch;

    const client = new OpenVikingClient({
      baseUrl: "http://127.0.0.1:1933"
    });

    await client.mkdir("viking://resources/openclaw/main/memory-sync/root");

    assert.strictEqual(calledUrl, "http://127.0.0.1:1933/api/v1/fs/mkdir");
    assert.strictEqual(calledInit?.method, "POST");
    assert.strictEqual(
      (calledInit?.body as string | undefined) ??
        "",
      JSON.stringify({ uri: "viking://resources/openclaw/main/memory-sync/root" })
    );
  });

  it("should throw OpenVikingHttpError on wrapped error response", async () => {
    globalThis.fetch = ((async () => {
      return new Response(
        JSON.stringify({
          status: "error",
          error: {
            code: "NOT_FOUND",
            message: "Resource not found"
          }
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as unknown) as typeof fetch;

    const client = new OpenVikingClient({
      baseUrl: "http://127.0.0.1:1933"
    });

    await assert.rejects(
      () => client.read("viking://resources/missing"),
      (error: unknown) => {
        if (!(error instanceof OpenVikingHttpError)) {
          return false;
        }
        return error.status === 404 && /Resource not found/.test(error.message);
      }
    );
  });
});
