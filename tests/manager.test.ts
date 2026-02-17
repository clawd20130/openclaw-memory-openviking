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
    let importSeq = 0;

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);
      const method = init?.method ?? "GET";

      if (urlText.endsWith("/api/v1/resources") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
        if (body.path) {
          uploadedPaths.push(body.path);
        }
        importSeq += 1;
        return okResponse({
          status: "queued",
          root_uri: `viking://resources/tmp/import-${importSeq}`,
          source_path: body.path ?? ""
        });
      }

      if (urlText.includes("/api/v1/fs?") && method === "DELETE") {
        return new Response(
          JSON.stringify({
            status: "error",
            error: {
              code: "NOT_FOUND",
              message: "not found"
            }
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (urlText.endsWith("/api/v1/fs/mv") && method === "POST") {
        return okResponse({ from: "", to: "" });
      }

      throw new Error(`Unexpected request: ${method} ${urlText}`);
    }) as unknown) as typeof fetch;

    const manager = new OpenVikingMemoryManager({
      config: {
        baseUrl: "http://127.0.0.1:1933",
        sync: {
          onBoot: false,
          extraPaths: ["notes"]
        }
      },
      workspaceDir: workspace,
      agentId: "main",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await manager.sync({ reason: "test" });

    assert.deepStrictEqual(uploadedPaths.toSorted(), [mdA, mdB].toSorted());
  });

  it("ignores extra paths outside workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "openviking-manager-workspace-"));
    const outside = await mkdtemp(path.join(tmpdir(), "openviking-manager-outside-"));
    await writeFile(path.join(outside, "outside.md"), "# outside\n", "utf-8");

    globalThis.fetch = ((async (url: string | URL | Request, init?: RequestInit) => {
      throw new Error(`No request expected, got: ${init?.method ?? "GET"} ${String(url)}`);
    }) as unknown) as typeof fetch;

    const manager = new OpenVikingMemoryManager({
      config: {
        baseUrl: "http://127.0.0.1:1933",
        sync: {
          onBoot: false,
          extraPaths: [outside]
        }
      },
      workspaceDir: workspace,
      agentId: "main",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await manager.sync({ reason: "test" });
  });
});
