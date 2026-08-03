import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

vi.mock("repocairn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("repocairn")>()),
  structuredCall: vi.fn(),
  getModel: () => "mock-model",
}));

import { structuredCall } from "repocairn";
import { runReview } from "../src/review.js";

const mockedCall = vi.mocked(structuredCall);

beforeEach(() => {
  mockedCall.mockReset();
});

/** A single-file unified diff whose one hunk adds `lines` short lines — used to
 * pad estimateTokens(JSON.stringify(hunks)) past chunkFiles' 60k-token cap. */
function bigDiff(file: string, lines: number): string {
  const added = Array.from({ length: lines }, (_, i) => `+  const x${i} = 1;`).join("\n");
  return `diff --git a/${file} b/${file}
index 1111111..2222222 100644
--- a/${file}
+++ b/${file}
@@ -1,1 +1,${lines + 1} @@
 export const start = 0;
${added}
`;
}

describe("chunking large diffs", () => {
  it("splits files across multiple LLM calls when the combined diff exceeds the per-call token budget, then merges results", async () => {
    // Each file's hunk JSON-stringifies to well over 40k tokens; the two
    // together exceed chunkFiles' 60k cap, forcing a second call.
    const diffText = [bigDiff("src/a.ts", 9000), bigDiff("src/b.ts", 9000)].join("\n");

    mockedCall
      .mockImplementationOnce(async (opts: { user: string }) => {
        expect(opts.user).toContain("src/a.ts");
        expect(opts.user).not.toContain("src/b.ts");
        return {
          summary: "chunk 1: touched a.ts",
          findings: [
            {
              file: "src/a.ts",
              start_line: 2,
              end_line: 2,
              severity: "low",
              category: "naming",
              confidence: 0.6,
              title: "finding in a",
              body: "x",
              suggestion: null,
            },
          ],
        };
      })
      .mockImplementationOnce(async (opts: { user: string }) => {
        expect(opts.user).toContain("src/b.ts");
        expect(opts.user).not.toContain("src/a.ts");
        return {
          summary: "chunk 2: touched b.ts",
          findings: [
            {
              file: "src/b.ts",
              start_line: 2,
              end_line: 2,
              severity: "low",
              category: "naming",
              confidence: 0.6,
              title: "finding in b",
              body: "y",
              suggestion: null,
            },
          ],
        };
      });

    const result = await runReview({
      cwd: process.cwd(),
      diffText,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "big diff",
      useContext: false,
    });

    expect(mockedCall).toHaveBeenCalledTimes(2);
    expect(result.stats.llmCalls).toBe(2);
    expect(result.findings.map((f) => f.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.summary).toContain("chunk 1");
    expect(result.summary).toContain("chunk 2");
  }, 20_000);
});

describe("retry on transient LLM failure", () => {
  const DIFF = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,1 +1,2 @@
 export function sum() {}
+export const extra = 1;
`;

  it("recovers when the LLM call fails once and succeeds on retry", async () => {
    mockedCall
      .mockRejectedValueOnce(new Error("upstream 529 overloaded"))
      .mockResolvedValueOnce({
        summary: "ok after retry",
        findings: [],
      });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "t",
      useContext: false,
    });

    expect(mockedCall).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe("ok after retry");
  });

  it("propagates the error once all retry attempts are exhausted, instead of swallowing it", async () => {
    mockedCall.mockRejectedValue(new Error("upstream 500"));

    await expect(
      runReview({
        cwd: process.cwd(),
        diffText: DIFF,
        config: { ...DEFAULT_CONFIG },
        changeDescription: "t",
        useContext: false,
      }),
    ).rejects.toThrow("upstream 500");

    expect(mockedCall).toHaveBeenCalledTimes(3);
  });
});

describe("renderSnippets with a missing context file", () => {
  it("skips a file the codemap references but that no longer exists on disk (sparse checkout / submodule not pulled), and still completes the review", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-review-missing-snip-"));
    try {
      await fs.mkdir(path.join(dir, ".repocairn"), { recursive: true });
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      await fs.writeFile(path.join(dir, "src", "math.ts"), "export function sum() {}\n");
      // app.ts is in the index but deliberately not written to disk.
      const index = {
        version: 1,
        generatedAt: new Date().toISOString(),
        files: {
          "src/math.ts": { symbols: ["export function sum"], imports: ["src/app.ts"], summary: "adds numbers" },
          "src/app.ts": { symbols: ["export const APP"], imports: [], summary: "app entry (file missing on disk)" },
        },
      };
      await fs.writeFile(path.join(dir, ".repocairn", "index.json"), JSON.stringify(index));

      mockedCall.mockResolvedValue({ summary: "s", findings: [] });

      const diffText = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,1 +1,2 @@
 export function sum() {}
+export const extra = 1;
`;

      const result = await runReview({
        cwd: dir,
        diffText,
        config: { ...DEFAULT_CONFIG },
        changeDescription: "t",
      });

      expect(result.summary).toBe("s");
      const user = mockedCall.mock.calls[0][0].user as string;
      // The summary/symbols context still lists app.ts (from the index)…
      expect(user).toContain("app entry (file missing on disk)");
      // …but no "full source" snippet was inlined for it, since readFile failed.
      expect(user).not.toContain("full source, import of the change");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
