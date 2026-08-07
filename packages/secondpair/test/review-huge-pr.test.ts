import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

vi.mock("repocairn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("repocairn")>()),
  structuredCall: vi.fn(),
  getModel: () => "mock-model",
}));

import { estimateTokens, structuredCall } from "repocairn";
import { runReview, totalDiffTokens } from "../src/review.js";
import { parseDiff } from "../src/diff/parse.js";
import { HIGH_LEVEL_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT } from "../src/llm/prompt.js";

const mockedCall = vi.mocked(structuredCall);

const DIFF = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,1 +1,2 @@
 export function sum() {}
+export const extra = 1;
`;

beforeEach(() => {
  mockedCall.mockReset();
});

describe("huge_pr_token_threshold — default (120000)", () => {
  it("leaves a normal-sized diff on the regular review path (regression guard)", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "t",
      useContext: false,
    });

    expect(result.highLevelReview).toBe(false);
    expect(mockedCall.mock.calls[0][0].system).toBe(REVIEW_SYSTEM_PROMPT);
  });
});

describe("huge_pr_token_threshold — exceeded", () => {
  it("switches to the high-level system prompt and marks highLevelReview true", async () => {
    mockedCall.mockResolvedValue({ summary: "split this up", findings: [] });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, huge_pr_token_threshold: 1 },
      changeDescription: "t",
      useContext: false,
    });

    expect(result.highLevelReview).toBe(true);
    expect(mockedCall.mock.calls[0][0].system).toBe(HIGH_LEVEL_SYSTEM_PROMPT);
  });

  it("skips self_critique even when the config enables it", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, huge_pr_token_threshold: 1, self_critique: true },
      changeDescription: "t",
      useContext: false,
    });

    // One call per chunk only — no extra critique call.
    expect(mockedCall).toHaveBeenCalledTimes(1);
  });

  it("null threshold disables the branch regardless of diff size", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false, huge_pr_token_threshold: null },
      changeDescription: "t",
      useContext: false,
    });

    expect(result.highLevelReview).toBe(false);
    expect(mockedCall.mock.calls[0][0].system).toBe(REVIEW_SYSTEM_PROMPT);
  });
});

describe("totalDiffTokens", () => {
  it("sums per-file token cost across all files in the diff", () => {
    const files = parseDiff(DIFF);
    const expected = files.reduce((sum, f) => sum + estimateTokens(JSON.stringify(f.hunks)), 0);
    expect(totalDiffTokens(files)).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });
});

describe("blastRadius", () => {
  it("matches selectContext's importer entries when a repocairn index is present", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-review-blast-radius-"));
    try {
      await fs.mkdir(path.join(dir, ".repocairn"), { recursive: true });
      const index = {
        version: 1,
        generatedAt: new Date().toISOString(),
        files: {
          "src/math.ts": { symbols: ["export function sum"], imports: [], summary: "math" },
          "src/app.ts": { symbols: ["export const APP"], imports: ["src/math.ts"], summary: "imports math" },
        },
      };
      await fs.writeFile(path.join(dir, ".repocairn", "index.json"), JSON.stringify(index));

      mockedCall.mockResolvedValue({ summary: "s", findings: [] });

      const result = await runReview({
        cwd: dir,
        diffText: DIFF,
        config: { ...DEFAULT_CONFIG },
        changeDescription: "t",
      });

      expect(result.blastRadius.map((e) => e.path)).toEqual(["src/app.ts"]);
      expect(result.blastRadius.every((e) => e.relation === "importer")).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is empty when context is disabled", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "t",
      useContext: false,
    });

    expect(result.blastRadius).toEqual([]);
  });
});
