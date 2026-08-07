import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyCliOverrides, DEFAULT_CONFIG, isIgnored, loadConfig, matchesGlob } from "../src/config.js";

async function tempRepoWithConfig(yaml: string | null): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-review-test-"));
  if (yaml !== null) {
    await writeFile(path.join(dir, ".pr-review.yml"), yaml, "utf8");
  }
  return dir;
}

describe("loadConfig", () => {
  it("returns defaults when no config file exists", async () => {
    const dir = await tempRepoWithConfig(null);
    const config = await loadConfig(dir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("merges partial config over defaults", async () => {
    const dir = await tempRepoWithConfig(
      ["fail_on: critical", "ignore:", '  - "docs/**"', "categories:", "  naming: false"].join("\n"),
    );
    const config = await loadConfig(dir);
    expect(config.fail_on).toBe("critical");
    expect(config.ignore).toEqual(["docs/**"]);
    expect(config.categories.naming).toBe(false);
    expect(config.categories.bug).toBe(true);
    expect(config.min_confidence).toBe(DEFAULT_CONFIG.min_confidence);
  });

  it("rejects unknown keys with a readable error", async () => {
    const dir = await tempRepoWithConfig("fail_onn: high\n");
    await expect(loadConfig(dir)).rejects.toThrow(/Invalid \.pr-review\.yml/);
  });

  it("rejects invalid severity values", async () => {
    const dir = await tempRepoWithConfig("fail_on: catastrophic\n");
    await expect(loadConfig(dir)).rejects.toThrow(/fail_on/);
  });

  it("rejects invalid redact_patterns regex", async () => {
    const dir = await tempRepoWithConfig('redact_patterns:\n  - "[unclosed"\n');
    await expect(loadConfig(dir)).rejects.toThrow(/redact_patterns/);
  });

  it("defaults redact_secrets true", async () => {
    const dir = await tempRepoWithConfig(null);
    expect((await loadConfig(dir)).redact_secrets).toBe(true);
  });
});

describe("glob matching", () => {
  it("matches ** across directories", () => {
    expect(matchesGlob("src/deep/nested/file.gen.ts", "**/*.gen.ts")).toBe(true);
    expect(matchesGlob("file.gen.ts", "**/*.gen.ts")).toBe(true);
    expect(matchesGlob("src/file.ts", "**/*.gen.ts")).toBe(false);
  });

  it("ignores node_modules and lockfiles by default", () => {
    expect(isIgnored("node_modules/pkg/index.js", DEFAULT_CONFIG)).toBe(true);
    expect(isIgnored("package-lock.json", DEFAULT_CONFIG)).toBe(true);
    expect(isIgnored("src/index.ts", DEFAULT_CONFIG)).toBe(false);
  });

  it("applies user ignore patterns", () => {
    const config = { ...DEFAULT_CONFIG, ignore: ["docs/**"] };
    expect(isIgnored("docs/guide.md", config)).toBe(true);
    expect(isIgnored("src/docs.ts", config)).toBe(false);
  });
});

describe("applyCliOverrides", () => {
  it("leaves config untouched when no overrides are passed", () => {
    expect(applyCliOverrides(DEFAULT_CONFIG, {})).toEqual(DEFAULT_CONFIG);
  });

  it("sets write_suppressions when the flag is present", () => {
    const config = applyCliOverrides(DEFAULT_CONFIG, { writeSuppressions: true });
    expect(config.write_suppressions).toBe(true);
  });

  it("overrides fail_on with a valid severity", () => {
    const config = applyCliOverrides(DEFAULT_CONFIG, { failOn: "critical" });
    expect(config.fail_on).toBe("critical");
  });

  it("throws on an invalid --fail-on value", () => {
    expect(() => applyCliOverrides(DEFAULT_CONFIG, { failOn: "yolo" })).toThrow(
      /--fail-on must be one of/,
    );
  });

  it("does not mutate the input config", () => {
    const input = { ...DEFAULT_CONFIG };
    applyCliOverrides(input, { failOn: "low", writeSuppressions: true });
    expect(input).toEqual(DEFAULT_CONFIG);
  });
});
