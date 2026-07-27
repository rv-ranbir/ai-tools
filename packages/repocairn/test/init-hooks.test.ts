import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPushPaths, listStagedPaths } from "../src/git-paths.js";
import { HOOK_MARKER, installHooks, runHook } from "../src/hooks.js";
import { runInit } from "../src/init.js";
import { loadIndex } from "../src/store.js";

const exec = promisify(execFile);

let dir: string;

async function git(args: string[]) {
  await exec("git", args, { cwd: dir });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "repocairn-init-"));
  await git(["init"]);
  await git(["config", "user.email", "t@t.com"]);
  await git(["config", "user.name", "t"]);
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", private: true }, null, 2),
  );
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "main.ts"), "export const main = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runInit", () => {
  it("writes package.json config, installs hooks, builds index", async () => {
    const result = await runInit(dir, { noHooks: false, noIndex: false });
    expect(result.steps.some((s) => s.includes("package.json"))).toBe(true);
    expect(result.steps.some((s) => s.includes("pre-commit"))).toBe(true);

    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    expect(pkg.repocairn.llm).toBe(false);

    const hook = await fs.readFile(path.join(dir, ".git", "hooks", "pre-commit"), "utf8");
    expect(hook).toContain(HOOK_MARKER);

    const index = await loadIndex(dir);
    expect(index?.files["src/main.ts"]).toBeDefined();
    expect(index?.files["src/main.ts"].summary).toBe("");
  });

  it("writes .repocairn.yml with --yml", async () => {
    await runInit(dir, { yml: true, noHooks: true, noIndex: true });
    const yml = await fs.readFile(path.join(dir, ".repocairn.yml"), "utf8");
    expect(yml).toContain("llm: false");
  });
});

describe("listStagedPaths + runHook", () => {
  it("lists staged source files", async () => {
    await fs.writeFile(path.join(dir, "src", "new.ts"), "export const n = 1;\n");
    await git(["add", "src/new.ts"]);
    const { update } = await listStagedPaths(dir);
    expect(update).toContain("src/new.ts");
  });

  it("hook updates index for staged files", async () => {
    await runInit(dir, { noHooks: true });
    await fs.writeFile(path.join(dir, "src", "extra.ts"), "export const extra = 1;\n");
    await git(["add", "src/extra.ts"]);
    const result = await runHook(dir, "pre-commit");
    expect(result.stats?.indexed).toBeGreaterThanOrEqual(1);
    const index = await loadIndex(dir);
    expect(index?.files["src/extra.ts"]).toBeDefined();
    // pre-commit stages the updated index so the commit carries it
    const { stdout: staged } = await exec("git", ["diff", "--cached", "--name-only"], { cwd: dir });
    expect(staged).toContain(".repocairn/index.json");
  });

  it("skips when hooks.pre-commit is false", async () => {
    await fs.writeFile(
      path.join(dir, ".repocairn.yml"),
      "hooks:\n  pre-commit: false\n  pre-push: true\nllm: false\n",
    );
    const result = await runHook(dir, "pre-commit");
    expect(result.skipped).toBe(true);
  });
});

describe("installHooks", () => {
  it("refuses to overwrite foreign hooks without --force", async () => {
    await fs.mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    await fs.writeFile(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho other\n");
    await expect(installHooks(dir)).rejects.toThrow(/already exists/);
  });
});

describe("listPushPaths", () => {
  it("parses stdin ref lines", async () => {
    await fs.writeFile(path.join(dir, "src", "p.ts"), "export const p = 1;\n");
    await git(["add", "."]);
    await git(["commit", "-m", "p"]);
    const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: dir });
    const { stdout: parent } = await exec("git", ["rev-parse", "HEAD~1"], { cwd: dir });
    const zero = "0".repeat(40);
    const stdin = `refs/heads/main ${head.trim()} refs/heads/main ${parent.trim()}\n`;
    const { update } = await listPushPaths(dir, stdin);
    expect(update.some((p) => p.endsWith("p.ts"))).toBe(true);
    // delete-ref line should be ignored
    const del = await listPushPaths(dir, `refs/heads/main ${zero} refs/heads/main ${head.trim()}\n`);
    expect(del.update).toEqual([]);
  });
});
