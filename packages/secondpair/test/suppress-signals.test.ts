import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectWontFixIds, isWontFixText } from "../src/suppress-signals.js";
import { appendSuppressionIds, loadSuppressions } from "../src/suppressions.js";

describe("isWontFixText", () => {
  it.each(["won't fix", "WONT FIX", "false positive", "not a bug"])(
    "matches %s",
    (s) => expect(isWontFixText(s)).toBe(true),
  );
  it("rejects unrelated", () => expect(isWontFixText("please fix this")).toBe(false));
});

describe("collectWontFixIds", () => {
  it("takes id from agent parent when reply says wont fix", () => {
    const ids = collectWontFixIds([
      {
        body: `bug\n<!-- pr-review-id: aabbccddeeff0011 -->\n<!-- secondpair -->`,
        isAgent: true,
      },
      {
        body: "won't fix — intentional",
        parentAgentId: "aabbccddeeff0011",
      },
    ]);
    expect([...ids]).toEqual(["aabbccddeeff0011"]);
  });

  it("includes reaction-only wont-fix with parent id", () => {
    const ids = collectWontFixIds([
      {
        body: "acknowledged",
        parentAgentId: "AABBCCDDEEFF0011",
        reactionWontFix: true,
      },
    ]);
    expect([...ids]).toEqual(["aabbccddeeff0011"]);
  });
});

describe("appendSuppressionIds", () => {
  it("creates file and dedupes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-review-suppress-"));
    expect(await appendSuppressionIds(dir, ["aaa"])).toBe(1);
    expect(await appendSuppressionIds(dir, ["aaa", "bbb"])).toBe(1);
    const s = await loadSuppressions(dir);
    expect(s.ids).toEqual(new Set(["aaa", "bbb"]));
  });

  it("returns 0 and skips write when id already listed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-review-suppress-"));
    const file = path.join(dir, ".pr-review-suppressions.yml");
    expect(await appendSuppressionIds(dir, ["aaa"])).toBe(1);
    const afterFirst = await readFile(file, "utf8");
    const mtimeMs = (await stat(file)).mtimeMs;
    expect(await appendSuppressionIds(dir, ["aaa"])).toBe(0);
    expect(await readFile(file, "utf8")).toBe(afterFirst);
    expect((await stat(file)).mtimeMs).toBe(mtimeMs);
  });
});
