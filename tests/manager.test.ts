import assert from "node:assert";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
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

function createTestManager(
  workspaceDir: string,
  sync?: { onBoot?: boolean; extraPaths?: string[]; ovConfigPath?: string }
) {
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

  it("skips unchanged files after manager restart via persisted snapshot", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-incremental-"));
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n", "utf-8");

    const desiredUri = "viking://resources/openclaw/main/memory-sync/root/MEMORY";
    const existing = new Set<string>(["viking://resources/openclaw/main/memory-sync/root"]);
    let importCount = 0;
    let deleteCount = 0;

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
        const uri = urlObj.searchParams.get("uri") ?? "";
        deleteCount += 1;
        existing.delete(uri);
        return okResponse({ uri });
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        importCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; target?: string };
        existing.add(desiredUri);
        return okResponse({
          status: "queued",
          root_uri: `${body.target}/${basenameWithoutExt(body.path ?? "")}`,
          source_path: body.path ?? ""
        });
      }

      throw new Error(`Unexpected request: ${method} ${urlObj.toString()}`);
    }) as unknown) as typeof fetch;

    const managerA = createTestManager(workspace);
    await managerA.sync({ reason: "test" });

    const managerB = createTestManager(workspace);
    await managerB.sync({ reason: "test" });

    assert.strictEqual(importCount, 1);
    assert.strictEqual(deleteCount, 0);
  });

  it("joins concurrent sync calls to avoid duplicate imports", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-concurrent-"));
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n", "utf-8");

    const desiredUri = "viking://resources/openclaw/main/memory-sync/root/MEMORY";
    const existing = new Set<string>([
      "viking://resources/openclaw/main/memory-sync",
      "viking://resources/openclaw/main/memory-sync/root"
    ]);
    let importCount = 0;

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
        const uri = urlObj.searchParams.get("uri") ?? "";
        existing.delete(uri);
        return okResponse({ uri });
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        importCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        existing.add(desiredUri);
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
    await Promise.all([manager.sync({ reason: "manual-a" }), manager.sync({ reason: "manual-b" })]);

    assert.strictEqual(importCount, 1);
  });

  it("adopts remote snapshot when local snapshot is missing and content matches", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-adopt-remote-"));
    const localContent = "# memory\nline1\nline2\n";
    await writeFile(path.join(workspace, "MEMORY.md"), localContent, "utf-8");

    const desiredUri = "viking://resources/openclaw/main/memory-sync/root/MEMORY";
    const rootPrefix = "viking://resources/openclaw/main/memory-sync";
    const existing = new Set<string>([rootPrefix, "viking://resources/openclaw/main/memory-sync/root", desiredUri]);
    let importCount = 0;

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

      if (urlObj.pathname === "/api/v1/content/read" && method === "GET") {
        return okResponse(localContent);
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        importCount += 1;
        throw new Error("resource import should be skipped when remote content matches");
      }

      if (urlObj.pathname === "/api/v1/fs/mkdir" && method === "POST") {
        throw new Error("mkdir is not expected when adoption succeeds");
      }

      if (urlObj.pathname === "/api/v1/fs" && method === "DELETE") {
        throw new Error("delete is not expected when adoption succeeds");
      }

      throw new Error(`Unexpected request: ${method} ${urlObj.toString()}`);
    }) as unknown) as typeof fetch;

    const manager = createTestManager(workspace);
    await manager.sync({ reason: "test" });

    assert.strictEqual(importCount, 0);
  });

  it("syncs file when remote snapshot content mismatches", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-adopt-mismatch-"));
    await writeFile(path.join(workspace, "MEMORY.md"), "# local\n", "utf-8");

    const desiredUri = "viking://resources/openclaw/main/memory-sync/root/MEMORY";
    const rootPrefix = "viking://resources/openclaw/main/memory-sync";
    const existing = new Set<string>([rootPrefix, "viking://resources/openclaw/main/memory-sync/root", desiredUri]);
    let importCount = 0;

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

      if (urlObj.pathname === "/api/v1/content/read" && method === "GET") {
        return okResponse("# remote\n");
      }

      if (urlObj.pathname === "/api/v1/fs/mkdir" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { uri?: string };
        if (body.uri) {
          existing.add(body.uri);
        }
        return okResponse({ uri: body.uri ?? "" });
      }

      if (urlObj.pathname === "/api/v1/fs" && method === "DELETE") {
        const uri = urlObj.searchParams.get("uri") ?? "";
        existing.delete(uri);
        return okResponse({ uri });
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        importCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; target?: string };
        existing.add(desiredUri);
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

  it("forces full sync when ov.conf fingerprint changes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-ovconf-"));
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n", "utf-8");
    await writeFile(path.join(workspace, "ov.conf"), "embedding=model-a\n", "utf-8");

    const desiredUri = "viking://resources/openclaw/main/memory-sync/root/MEMORY";
    const existing = new Set<string>(["viking://resources/openclaw/main/memory-sync/root"]);
    let importCount = 0;
    let deleteCount = 0;

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
        const uri = urlObj.searchParams.get("uri") ?? "";
        deleteCount += 1;
        existing.delete(uri);
        return okResponse({ uri });
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        importCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; target?: string };
        existing.add(desiredUri);
        return okResponse({
          status: "queued",
          root_uri: `${body.target}/${basenameWithoutExt(body.path ?? "")}`,
          source_path: body.path ?? ""
        });
      }

      throw new Error(`Unexpected request: ${method} ${urlObj.toString()}`);
    }) as unknown) as typeof fetch;

    const managerA = createTestManager(workspace, { ovConfigPath: "ov.conf" });
    await managerA.sync({ reason: "test" });

    const managerB = createTestManager(workspace, { ovConfigPath: "ov.conf" });
    await managerB.sync({ reason: "test" });
    assert.strictEqual(importCount, 1);
    assert.strictEqual(deleteCount, 0);

    await writeFile(path.join(workspace, "ov.conf"), "embedding=model-b\n", "utf-8");

    const managerC = createTestManager(workspace, { ovConfigPath: "ov.conf" });
    await managerC.sync({ reason: "test" });

    assert.strictEqual(importCount, 2);
    assert.strictEqual(deleteCount, 1);
  });

  it("removes stale remote file when local file is deleted", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-delete-stale-"));
    const memoryPath = path.join(workspace, "MEMORY.md");
    await writeFile(memoryPath, "# memory\n", "utf-8");

    const desiredUri = "viking://resources/openclaw/main/memory-sync/root/MEMORY";
    const existing = new Set<string>(["viking://resources/openclaw/main/memory-sync/root"]);
    let importCount = 0;
    let deleteCount = 0;

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlObj = new URL(String(url));

      if (urlObj.pathname === "/api/v1/fs/stat" && method === "GET") {
        const uri = urlObj.searchParams.get("uri") ?? "";
        if (existing.has(uri)) {
          return okResponse({ uri, isDir: uri.endsWith("/root") });
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
        const uri = urlObj.searchParams.get("uri") ?? "";
        deleteCount += 1;
        existing.delete(uri);
        return okResponse({ uri });
      }

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        importCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; target?: string };
        existing.add(desiredUri);
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
    await rm(memoryPath);
    await manager.sync({ reason: "test" });

    assert.strictEqual(importCount, 1);
    assert.strictEqual(deleteCount, 1);
  });

  it("forces recovery full sync when previous snapshot was left running", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-recover-running-"));
    const memoryPath = path.join(workspace, "MEMORY.md");
    await writeFile(memoryPath, "# memory\n", "utf-8");

    const desiredUri = "viking://resources/openclaw/main/memory-sync/root/MEMORY";
    const memoryStat = await stat(memoryPath);
    const fingerprint = `${memoryStat.size}:${Math.trunc(memoryStat.mtimeMs)}`;

    const snapshotDir = path.join(workspace, ".openclaw", "plugins", "openviking-memory");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(
      path.join(snapshotDir, "main.sync-state.json"),
      `${JSON.stringify(
        {
          version: 3,
          agentId: "main",
          entries: [
            {
              relPath: "MEMORY.md",
              fingerprint,
              uri: desiredUri
            }
          ],
          lastRunStatus: "running"
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    let importCount = 0;
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

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        importCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; target?: string };
        return okResponse({
          status: "queued",
          root_uri: `${body.target}/${basenameWithoutExt(body.path ?? "")}`,
          source_path: body.path ?? ""
        });
      }

      if (urlObj.pathname === "/api/v1/fs/mkdir" && method === "POST") {
        return okResponse({ uri: "" });
      }

      if (urlObj.pathname === "/api/v1/fs" && method === "DELETE") {
        throw new Error("DELETE not expected");
      }

      throw new Error(`Unexpected request: ${method} ${urlObj.toString()}`);
    }) as unknown) as typeof fetch;

    const manager = createTestManager(workspace);
    await manager.sync({ reason: "test" });

    assert.strictEqual(importCount, 1);
  });

  it("forces recovery full sync after a failed previous run", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-recover-failed-"));
    const memoryPath = path.join(workspace, "MEMORY.md");
    await writeFile(memoryPath, "# memory\n", "utf-8");

    const desiredUri = "viking://resources/openclaw/main/memory-sync/root/MEMORY";
    const memoryStat = await stat(memoryPath);
    const fingerprint = `${memoryStat.size}:${Math.trunc(memoryStat.mtimeMs)}`;

    const snapshotDir = path.join(workspace, ".openclaw", "plugins", "openviking-memory");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(
      path.join(snapshotDir, "main.sync-state.json"),
      `${JSON.stringify(
        {
          version: 3,
          agentId: "main",
          entries: [
            {
              relPath: "MEMORY.md",
              fingerprint,
              uri: desiredUri
            }
          ],
          lastRunStatus: "success"
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    let phase = 1;
    let firstAttemptImports = 0;
    let secondAttemptImports = 0;
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

      if (urlObj.pathname === "/api/v1/resources" && method === "POST") {
        if (phase === 1) {
          firstAttemptImports += 1;
          return new Response(
            JSON.stringify({
              status: "error",
              error: {
                code: "INTERNAL_ERROR",
                message: "import failed"
              }
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" }
            }
          );
        }

        secondAttemptImports += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; target?: string };
        return okResponse({
          status: "queued",
          root_uri: `${body.target}/${basenameWithoutExt(body.path ?? "")}`,
          source_path: body.path ?? ""
        });
      }

      if (urlObj.pathname === "/api/v1/fs/mkdir" && method === "POST") {
        return okResponse({ uri: "" });
      }

      if (urlObj.pathname === "/api/v1/fs" && method === "DELETE") {
        throw new Error("DELETE not expected");
      }

      throw new Error(`Unexpected request: ${method} ${urlObj.toString()}`);
    }) as unknown) as typeof fetch;

    const managerA = createTestManager(workspace);
    await managerA.sync({ reason: "test", force: true });
    phase = 2;

    const managerB = createTestManager(workspace);
    await managerB.sync({ reason: "test" });

    assert.strictEqual(firstAttemptImports, 1);
    assert.strictEqual(secondAttemptImports, 1);
  });
});
