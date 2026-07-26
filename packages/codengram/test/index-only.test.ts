import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/index-command.js";
import { loadIndex } from "../src/store.js";

const exec = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "codengram-only-"));
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(dir, "src", "b.ts"), "export const b = 2;\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-m", "init"], { cwd: dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runIndex only-mode", () => {
  it("indexes only listed paths and leaves others alone", async () => {
    await runIndex({ cwd: dir, llm: false });
    let index = await loadIndex(dir);
    expect(index?.files["src/a.ts"]).toBeDefined();
    expect(index?.files["src/b.ts"]).toBeDefined();

    await fs.writeFile(path.join(dir, "src", "a.ts"), "export const a = 99;\n");
    await fs.writeFile(path.join(dir, "src", "b.ts"), "export const b = 99;\n");

    await runIndex({ cwd: dir, llm: false, only: ["src/a.ts"] });
    index = await loadIndex(dir);
    expect(index?.files["src/a.ts"]?.symbols.some((s) => s.includes("a"))).toBe(true);
    // b still present; hash would be stale vs disk but only-mode does not touch it
    expect(index?.files["src/b.ts"]).toBeDefined();
    const hashBBefore = index!.files["src/b.ts"].hash;

    await runIndex({ cwd: dir, llm: false, only: ["src/b.ts"] });
    index = await loadIndex(dir);
    expect(index!.files["src/b.ts"].hash).not.toBe(hashBBefore);
  });

  it("removes explicit paths without full-tree prune", async () => {
    await runIndex({ cwd: dir, llm: false });
    await runIndex({ cwd: dir, llm: false, only: [], remove: ["src/a.ts"] });
    const index = await loadIndex(dir);
    expect(index?.files["src/a.ts"]).toBeUndefined();
    expect(index?.files["src/b.ts"]).toBeDefined();
  });

  it("no-ops when only and remove are empty", async () => {
    await runIndex({ cwd: dir, llm: false });
    const before = await loadIndex(dir);
    const stats = await runIndex({ cwd: dir, llm: false, only: [], remove: [] });
    expect(stats.indexed).toBe(0);
    const after = await loadIndex(dir);
    expect(after?.generatedAt).toBe(before?.generatedAt);
  });
});
