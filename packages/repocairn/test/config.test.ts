import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REPOCAIRN_CONFIG,
  loadRepoCairnConfig,
  mergeRepoCairnConfig,
} from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "repocairn-cfg-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadRepoCairnConfig", () => {
  it("returns defaults when nothing is present", async () => {
    expect(await loadRepoCairnConfig(dir)).toEqual(DEFAULT_REPOCAIRN_CONFIG);
  });

  it("reads package.json#repocairn", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        repocairn: { llm: true, hooks: { "pre-commit": false }, ignore: ["docs/**"] },
      }),
    );
    const cfg = await loadRepoCairnConfig(dir);
    expect(cfg.llm).toBe(true);
    expect(cfg.hooks["pre-commit"]).toBe(false);
    expect(cfg.hooks["pre-push"]).toBe(true);
    expect(cfg.ignore).toEqual(["docs/**"]);
  });

  it("prefers .repocairn.yml over package.json", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ repocairn: { llm: true } }),
    );
    await fs.writeFile(path.join(dir, ".repocairn.yml"), "llm: false\nhooks:\n  pre-push: false\n");
    const cfg = await loadRepoCairnConfig(dir);
    expect(cfg.llm).toBe(false);
    expect(cfg.hooks["pre-push"]).toBe(false);
    expect(cfg.hooks["pre-commit"]).toBe(true);
  });

  it("rejects unknown keys", async () => {
    await fs.writeFile(path.join(dir, ".repocairn.yml"), "unknown: 1\n");
    await expect(loadRepoCairnConfig(dir)).rejects.toThrow(/Invalid/);
  });
});

describe("mergeRepoCairnConfig", () => {
  it("fills defaults", () => {
    expect(mergeRepoCairnConfig({})).toEqual(DEFAULT_REPOCAIRN_CONFIG);
  });
});
