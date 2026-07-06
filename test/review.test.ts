import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

// Mock the LLM client — tests never hit a real API.
vi.mock("../src/llm/client.js", () => ({
  structuredCall: vi.fn(),
  getModel: () => "mock-model",
  resolveProvider: () => ({ provider: "anthropic", model: "mock-model", baseUrl: "", apiKey: "" }),
}));

import { structuredCall } from "../src/llm/client.js";
import { runReview } from "../src/review.js";

const mockedCall = vi.mocked(structuredCall);

const DIFF = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,4 @@
 export function sum(xs: number[]) {
-  return xs.reduce((a, b) => a + b);
+  let total = 0;
+  for (let i = 0; i <= xs.length; i++) total += xs[i];
   return total;
`;

beforeEach(() => {
  mockedCall.mockReset();
});

describe("runReview", () => {
  it("passes the diff to the LLM and returns validated findings", async () => {
    mockedCall.mockResolvedValueOnce({
      summary: "Rewrote sum with an off-by-one loop bound.",
      findings: [
        {
          file: "src/math.ts",
          start_line: 2,
          end_line: 3,
          severity: "high",
          category: "bug",
          confidence: 0.95,
          title: "Loop reads past the end of the array",
          body: "`i <= xs.length` accesses `xs[xs.length]` (undefined), making the total NaN.",
          suggestion: null,
        },
        {
          // Outside the diff — must be dropped by validation.
          file: "src/other.ts",
          start_line: 1,
          end_line: 1,
          severity: "critical",
          category: "bug",
          confidence: 0.9,
          title: "Hallucinated finding",
          body: "not in the diff",
          suggestion: null,
        },
      ],
    });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "test diff",
      useContext: false,
    });

    expect(mockedCall).toHaveBeenCalledTimes(1);
    const callArg = mockedCall.mock.calls[0][0];
    expect(callArg.user).toContain("src/math.ts");
    expect(callArg.user).toContain("i <= xs.length");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toContain("past the end");
    expect(result.dropped).toHaveLength(1);
    expect(result.usedContext).toBe(false);
  });

  it("returns cleanly on a diff with only ignored files", async () => {
    const lockDiff = DIFF.replaceAll("src/math.ts", "package-lock.json");
    const result = await runReview({
      cwd: process.cwd(),
      diffText: lockDiff,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "test diff",
      useContext: false,
    });
    expect(mockedCall).not.toHaveBeenCalled();
    expect(result.findings).toEqual([]);
  });
});
