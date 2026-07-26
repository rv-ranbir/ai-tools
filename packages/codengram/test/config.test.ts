import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CODENGRAM_CONFIG,
  loadCodengramConfig,
  mergeCodengramConfig,
} from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "codengram-cfg-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadCodengramConfig", () => {
  it("returns defaults when nothing is present", async () => {
    expect(await loadCodengramConfig(dir)).toEqual(DEFAULT_CODENGRAM_CONFIG);
  });

  it("reads package.json#codengram", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        codengram: { llm: true, hooks: { "pre-commit": false }, ignore: ["docs/**"] },
      }),
    );
    const cfg = await loadCodengramConfig(dir);
    expect(cfg.llm).toBe(true);
    expect(cfg.hooks["pre-commit"]).toBe(false);
    expect(cfg.hooks["pre-push"]).toBe(true);
    expect(cfg.ignore).toEqual(["docs/**"]);
  });

  it("prefers .codengram.yml over package.json", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ codengram: { llm: true } }),
    );
    await fs.writeFile(path.join(dir, ".codengram.yml"), "llm: false\nhooks:\n  pre-push: false\n");
    const cfg = await loadCodengramConfig(dir);
    expect(cfg.llm).toBe(false);
    expect(cfg.hooks["pre-push"]).toBe(false);
    expect(cfg.hooks["pre-commit"]).toBe(true);
  });

  it("rejects unknown keys", async () => {
    await fs.writeFile(path.join(dir, ".codengram.yml"), "unknown: 1\n");
    await expect(loadCodengramConfig(dir)).rejects.toThrow(/Invalid/);
  });
});

describe("mergeCodengramConfig", () => {
  it("fills defaults", () => {
    expect(mergeCodengramConfig({})).toEqual(DEFAULT_CODENGRAM_CONFIG);
  });
});
