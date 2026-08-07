import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseDiff } from "../src/diff/parse.js";
import { CATEGORIES } from "../src/types.js";

vi.mock("repocairn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("repocairn")>()),
  structuredCall: vi.fn(),
}));

import { structuredCall } from "repocairn";
import { QUALITY_LENS_SYSTEM_PROMPT, SECURITY_LENS_SYSTEM_PROMPT } from "../src/llm/prompt.js";
import { LENS_DEFINITIONS, runSpecializedReview } from "../src/specialized-review.js";

const mockedCall = vi.mocked(structuredCall);

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 export function f() {}
+export const x = 1;
`;

beforeEach(() => {
  mockedCall.mockReset();
});

describe("LENS_DEFINITIONS", () => {
  it("partitions CATEGORIES into a strict disjoint cover", () => {
    const all = LENS_DEFINITIONS.flatMap((l) => l.categories);
    expect([...all].sort()).toEqual([...CATEGORIES].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("only the quality lens skips repository context", () => {
    const byKey = Object.fromEntries(LENS_DEFINITIONS.map((l) => [l.key, l.includeContext]));
    expect(byKey).toEqual({ security: true, correctness: true, quality: false });
  });
});

describe("runSpecializedReview", () => {
  it("runs one concurrent call per lens and reports per-lens stats", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const files = parseDiff(DIFF);
    const { outputs, lensStats } = await runSpecializedReview({
      files,
      context: "some context",
      signalsText: "",
      config: DEFAULT_CONFIG,
      changeDescription: "t",
      temperature: undefined,
    });

    expect(outputs).toHaveLength(3);
    expect(mockedCall).toHaveBeenCalledTimes(3);
    expect(Object.keys(lensStats).sort()).toEqual(["correctness", "quality", "security"]);
    for (const stat of Object.values(lensStats)) expect(stat.calls).toBe(1);
  });

  it("omits repository context from the quality lens's prompt only", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const files = parseDiff(DIFF);
    await runSpecializedReview({
      files,
      context: "REAL CONTEXT MARKER",
      signalsText: "",
      config: DEFAULT_CONFIG,
      changeDescription: "t",
      temperature: undefined,
    });

    const calls = mockedCall.mock.calls;
    const qualityCall = calls.find((c) => c[0].system === QUALITY_LENS_SYSTEM_PROMPT);
    const securityCall = calls.find((c) => c[0].system === SECURITY_LENS_SYSTEM_PROMPT);
    expect(qualityCall![0].user as string).not.toContain("REAL CONTEXT MARKER");
    expect(securityCall![0].user as string).toContain("REAL CONTEXT MARKER");
  });

  it("filters each lens's findings down to its own category slice, even if the model disobeys", async () => {
    mockedCall.mockResolvedValue({
      summary: "s",
      findings: [
        {
          file: "src/a.ts",
          start_line: 2,
          end_line: 2,
          severity: "low",
          category: "security",
          confidence: 0.9,
          title: "t1",
          body: "b",
          suggestion: null,
        },
        {
          file: "src/a.ts",
          start_line: 2,
          end_line: 2,
          severity: "low",
          category: "naming",
          confidence: 0.9,
          title: "t2",
          body: "b",
          suggestion: null,
        },
      ],
    });

    const files = parseDiff(DIFF);
    const { outputs } = await runSpecializedReview({
      files,
      context: "",
      signalsText: "",
      config: DEFAULT_CONFIG,
      changeDescription: "t",
      temperature: undefined,
    });

    // Order follows LENS_DEFINITIONS: security, correctness, quality.
    expect(outputs[0].findings.map((f) => f.category)).toEqual(["security"]);
    expect(outputs[1].findings).toEqual([]);
    expect(outputs[2].findings.map((f) => f.category)).toEqual(["naming"]);
  });
});
