/**
 * 路径映射器测试
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { PathMapper } from "../src/mapper.js";

describe("PathMapper", () => {
  describe("toVikingUri", () => {
    it("should map MEMORY.md correctly", () => {
      const mapper = new PathMapper();
      assert.strictEqual(
        mapper.toVikingUri("MEMORY.md"),
        "viking://resources/openclaw/main/memory-sync/root/MEMORY"
      );
    });

    it("should map SOUL.md correctly", () => {
      const mapper = new PathMapper();
      assert.strictEqual(
        mapper.toVikingUri("SOUL.md"),
        "viking://resources/openclaw/main/memory-sync/root/SOUL"
      );
    });

    it("should map daily memory files correctly", () => {
      const mapper = new PathMapper();
      assert.strictEqual(
        mapper.toVikingUri("memory/2025-06-18.md"),
        "viking://resources/openclaw/main/memory-sync/memory/2025-06-18"
      );
    });

    it("should map skill files correctly", () => {
      const mapper = new PathMapper();
      assert.strictEqual(
        mapper.toVikingUri("skills/weather/SKILL.md"),
        "viking://resources/openclaw/main/memory-sync/skills/weather/SKILL"
      );
    });

    it("should use custom mappings", () => {
      const mapper = new PathMapper({
        "custom.md": "viking://custom/path"
      });
      assert.strictEqual(
        mapper.toVikingUri("custom.md"),
        "viking://custom/path"
      );
    });

    it("should build content URI from local path", () => {
      const mapper = new PathMapper();
      assert.strictEqual(
        mapper.toContentUri("MEMORY.md"),
        "viking://resources/openclaw/main/memory-sync/root/MEMORY/MEMORY.md"
      );
    });
  });

  describe("fromVikingUri", () => {
    it("should reverse map MEMORY.md", () => {
      const mapper = new PathMapper();
      assert.strictEqual(
        mapper.fromVikingUri("viking://resources/openclaw/main/memory-sync/root/MEMORY"),
        "MEMORY.md"
      );
    });

    it("should reverse map daily files", () => {
      const mapper = new PathMapper();
      assert.strictEqual(
        mapper.fromVikingUri("viking://resources/openclaw/main/memory-sync/memory/2025-06-18"),
        "memory/2025-06-18.md"
      );
    });

    it("should fallback gracefully for unknown URIs", () => {
      const mapper = new PathMapper();
      const result = mapper.fromVikingUri("viking://unknown/path");
      assert.ok(result.includes("unknown/path") || result === "unknown/path");
    });
  });
});
