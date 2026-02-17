import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { OpenVikingMemoryManager } from "../src/manager.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function okResponse(result: unknown): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      result
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}

function notFoundResponse(message = "not found"): Response {
  return new Response(
    JSON.stringify({
      status: "error",
      error: {
        code: "NOT_FOUND",
        message
      }
    }),
    {
      status: 404,
      headers: { "Content-Type": "application/json" }
    }
  );
}

function basenameWithoutExt(filePath: string): string {
  return path.parse(filePath).name;
}

function createTestManager(workspaceDir: string, sync?: { onBoot?: boolean; extraPaths?: string[] }) {
  return new OpenVikingMemoryManager({
    config: {
      baseUrl: "http://127.0.0.1:1933",
      sync: {
        onBoot: false,
        ...sync
      }
    },
    workspaceDir,
    agentId: "main",
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }
  });
}

describe("OpenVikingMemoryManager sync.extraPaths", () => {
  it("recursively syncs markdown files under configured extra paths", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-extra-"));
    await mkdir(path.join(workspace, "notes", "nested"), { recursive: true });

    const mdA = path.join(workspace, "notes", "a.md");
    const mdB = path.join(workspace, "notes", "nested", "b.md");
    await writeFile(mdA, "# a\n", "utf-8");
    await writeFile(mdB, "# b\n", "utf-8");
    await writeFile(path.join(workspace, "notes", "ignore.txt"), "ignore\n", "utf-8");

    const uploadedPaths: string[] = [];
    const importTargets: string[] = [];
    let moved = 0;
    const existing = new Set<string>();

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlObj = new URL(String(url));

      if (urlObj.pathname === "/api/v1/fs/stat" && method === "GET") {
        const uri = urlObj.searchParams.get("uri") ?? "";
        if (existing.has(uri)) {
          return okResponse({ uri, isDir: true });
        }
        return notFoundResponse(`Resource not found: ${uri}`);
      }

      if (urlObj.pathname === "/api/v1/fs/mkdir" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { uri?: string };
        if (body.uri) {
          existing.add(body.uri);
        }
        return okResponse({ uri: body.uri ?? "" });
      }

      if (urlObj.pathname === "/api/v1/fs" && method === "DELETE") {
        throw new Error("DELETE /api/v1/fs is not expected in this test");
      }

      if (urlObj.pathname === "/api/v1/fs/mv" && method === "POST") {
        moved += 1;
        return okResponse({ from: "", to: "" });
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          path?: string;
          target?: string;
        };
        if (body.path) {
          uploadedPaths.push(body.path);
        }
        if (body.target) {
          importTargets.push(body.target);
          existing.add(`${body.target}/${basenameWithoutExt(body.path ?? "")}`);
        }
        return okResponse({
          status: "queued",
          root_uri: `${body.target}/${basenameWithoutExt(body.path ?? "")}`,
          source_path: body.path ?? ""
        });
      }

      throw new Error(`Unexpected request: ${method} ${urlObj.toString()}`);
    }) as unknown) as typeof fetch;

    const manager = createTestManager(workspace, { extraPaths: ["notes"] });
    await manager.sync({ reason: "test" });

    assert.deepStrictEqual(uploadedPaths.toSorted(), [mdA, mdB].toSorted());
    assert.deepStrictEqual(
      importTargets.toSorted(),
      [
        "viking://resources/openclaw/main/memory-sync/files/notes",
        "viking://resources/openclaw/main/memory-sync/files/notes/nested"
      ].toSorted()
    );
    assert.strictEqual(moved, 0);
  });

  it("ignores extra paths outside workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-workspace-"));
    const outside = await mkdtemp(path.join(tmpdir(), "openviking-manager-outside-"));
    await writeFile(path.join(outside, "outside.md"), "# outside\n", "utf-8");

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      throw new Error(`No request expected, got: ${init?.method ?? "GET"} ${String(url)}`);
    }) as unknown) as typeof fetch;

    const manager = createTestManager(workspace, { extraPaths: [outside] });
    await manager.sync({ reason: "test" });
  });

  it("skips delete when target path is missing", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-skip-delete-"));
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n", "utf-8");

    let deleteCalls = 0;
    const existing = new Set<string>(["viking://resources/openclaw/main/memory-sync/root"]);

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlObj = new URL(String(url));

      if (urlObj.pathname === "/api/v1/fs/stat" && method === "GET") {
        const uri = urlObj.searchParams.get("uri") ?? "";
        if (existing.has(uri)) {
          return okResponse({ uri, isDir: true });
        }
        return notFoundResponse(`Resource not found: ${uri}`);
      }

      if (urlObj.pathname === "/api/v1/fs/mkdir" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { uri?: string };
        if (body.uri) {
          existing.add(body.uri);
        }
        return okResponse({ uri: body.uri ?? "" });
      }

      if (urlObj.pathname === "/api/v1/fs" && method === "DELETE") {
        deleteCalls += 1;
        return okResponse({ uri: urlObj.searchParams.get("uri") ?? "" });
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; target?: string };
        return okResponse({
          status: "queued",
          root_uri: `${body.target}/${basenameWithoutExt(body.path ?? "")}`,
          source_path: body.path ?? ""
        });
      }

      throw new Error(`Unexpected request: ${method} ${urlObj.toString()}`);
    }) as unknown) as typeof fetch;

    const manager = createTestManager(workspace);
    await manager.sync({ reason: "test" });

    assert.strictEqual(deleteCalls, 0);
  });

  it("deletes existing target before importing replacement", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-replace-"));
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n", "utf-8");

    const desiredUri = "viking://resources/openclaw/main/memory-sync/root/MEMORY";
    const existing = new Set<string>([
      "viking://resources/openclaw/main/memory-sync/root",
      desiredUri
    ]);
    let deleteCalls = 0;
    let moved = 0;

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlObj = new URL(String(url));

      if (urlObj.pathname === "/api/v1/fs/stat" && method === "GET") {
        const uri = urlObj.searchParams.get("uri") ?? "";
        if (existing.has(uri)) {
          return okResponse({ uri, isDir: true });
        }
        return notFoundResponse(`Resource not found: ${uri}`);
      }

      if (urlObj.pathname === "/api/v1/fs" && method === "DELETE") {
        const uri = urlObj.searchParams.get("uri") ?? "";
        deleteCalls += 1;
        existing.delete(uri);
        return okResponse({ uri });
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        if (existing.has(desiredUri)) {
          throw new Error("expected old target removed before import");
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; target?: string };
        return okResponse({
          status: "queued",
          root_uri: `${body.target}/${basenameWithoutExt(body.path ?? "")}`,
          source_path: body.path ?? ""
        });
      }

      if (urlObj.pathname === "/api/v1/fs/mv" && method === "POST") {
        moved += 1;
        return okResponse({ from: "", to: "" });
      }

      if (urlObj.pathname === "/api/v1/fs/mkdir" && method === "POST") {
        return okResponse({ uri: "" });
      }

      throw new Error(`Unexpected request: ${method} ${urlObj.toString()}`);
    }) as unknown) as typeof fetch;

    const manager = createTestManager(workspace);
    await manager.sync({ reason: "test" });

    assert.strictEqual(deleteCalls, 1);
    assert.strictEqual(moved, 0);
  });

  it("continues sync when mkdir races and reports already-exists", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-mkdir-race-"));
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n", "utf-8");

    let importCount = 0;

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlObj = new URL(String(url));

      if (urlObj.pathname === "/api/v1/fs/stat" && method === "GET") {
        return notFoundResponse("Resource not found");
      }

      if (urlObj.pathname === "/api/v1/fs/mkdir" && method === "POST") {
        return new Response(
          JSON.stringify({
            status: "error",
            error: {
              code: "INTERNAL_ERROR",
              message: "directory already exists: /resources/openclaw/main/memory-sync/root"
            }
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        importCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; target?: string };
        return okResponse({
          status: "queued",
          root_uri: `${body.target}/${basenameWithoutExt(body.path ?? "")}`,
          source_path: body.path ?? ""
        });
      }

      throw new Error(`Unexpected request: ${method} ${urlObj.toString()}`);
    }) as unknown) as typeof fetch;

    const manager = createTestManager(workspace);
    await manager.sync({ reason: "test" });

    assert.strictEqual(importCount, 1);
  });
});
