import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSuppressions, SUPPRESSIONS_FILENAME } from "../src/suppressions.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-review-suppr-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadSuppressions", () => {
  it("returns an empty set when no file exists at the default path", async () => {
    const result = await loadSuppressions(dir);
    expect(result.ids.size).toBe(0);
  });

  it("throws when an explicit --suppressions path doesn't exist", async () => {
    await expect(loadSuppressions(dir, path.join(dir, "nope.yml"))).rejects.toThrow(
      "Suppressions file not found",
    );
  });

  it("lowercases ids for case-insensitive matching", async () => {
    await fs.writeFile(
      path.join(dir, SUPPRESSIONS_FILENAME),
      "ids:\n  - ABC123\n  - def456\n",
    );
    const result = await loadSuppressions(dir);
    expect(result.ids).toEqual(new Set(["abc123", "def456"]));
  });

  it("treats an empty file as no suppressions", async () => {
    await fs.writeFile(path.join(dir, SUPPRESSIONS_FILENAME), "");
    const result = await loadSuppressions(dir);
    expect(result.ids.size).toBe(0);
  });

  it("rejects unknown top-level keys", async () => {
    await fs.writeFile(path.join(dir, SUPPRESSIONS_FILENAME), "ids:\n  - a\nnotes: oops\n");
    await expect(loadSuppressions(dir)).rejects.toThrow(/Invalid/);
  });

  it("rejects malformed YAML with a readable error, not a raw parser crash", async () => {
    await fs.writeFile(path.join(dir, SUPPRESSIONS_FILENAME), "ids: [a, b\n");
    await expect(loadSuppressions(dir)).rejects.toThrow();
  });

  it("respects an explicit --suppressions path pointing outside the repo root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pr-review-suppr-outside-"));
    try {
      const file = path.join(outside, "shared-suppressions.yml");
      await fs.writeFile(file, "ids:\n  - shared1\n");
      const result = await loadSuppressions(dir, file);
      expect(result.ids).toEqual(new Set(["shared1"]));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
