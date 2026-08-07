import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

vi.mock("repocairn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("repocairn")>()),
  structuredCall: vi.fn(),
  getModel: () => "mock-model",
}));

import { structuredCall } from "repocairn";
import {
  CORRECTNESS_LENS_SYSTEM_PROMPT,
  HIGH_LEVEL_SYSTEM_PROMPT,
  SECURITY_LENS_SYSTEM_PROMPT,
} from "../src/llm/prompt.js";
import { runReview } from "../src/review.js";

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

describe("parallel_agents — default (true)", () => {
  it("runs the parallel lens path without opting in explicitly", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "t",
      useContext: false,
    });

    expect(mockedCall).toHaveBeenCalledTimes(3);
    expect(result.stats.lensStats).toBeDefined();
  });
});

describe("parallel_agents — explicit opt-out (false)", () => {
  it("leaves behavior identical to the sequential path", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "t",
      useContext: false,
    });

    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(result.stats.lensStats).toBeUndefined();
  });
});

describe("parallel_agents — enabled", () => {
  it("runs 3 lens calls per chunk and merges findings through the normal pipeline", async () => {
    mockedCall.mockImplementation(async ({ system }) => {
      if (system === SECURITY_LENS_SYSTEM_PROMPT) {
        return {
          summary: "sec",
          findings: [
            {
              file: "src/a.ts",
              start_line: 2,
              end_line: 2,
              severity: "high",
              category: "security",
              confidence: 0.9,
              title: "sec issue",
              body: "b",
              suggestion: null,
            },
          ],
        };
      }
      if (system === CORRECTNESS_LENS_SYSTEM_PROMPT) {
        return {
          summary: "cor",
          findings: [
            {
              file: "src/a.ts",
              start_line: 2,
              end_line: 2,
              severity: "high",
              category: "bug",
              confidence: 0.9,
              title: "bug issue",
              body: "b",
              suggestion: null,
            },
          ],
        };
      }
      return {
        summary: "qual",
        findings: [
          {
            file: "src/a.ts",
            start_line: 2,
            end_line: 2,
            severity: "low",
            category: "naming",
            confidence: 0.9,
            title: "naming issue",
            body: "b",
            suggestion: null,
          },
        ],
      };
    });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: true },
      changeDescription: "t",
      useContext: false,
    });

    expect(mockedCall).toHaveBeenCalledTimes(3);
    expect(result.stats.llmCalls).toBe(3);
    expect(result.stats.lensStats && Object.keys(result.stats.lensStats).sort()).toEqual([
      "correctness",
      "quality",
      "security",
    ]);
    expect(result.findings.map((f) => f.category).sort()).toEqual(["bug", "naming", "security"]);
  });
});

describe("parallel_agents + huge_pr_token_threshold", () => {
  it("huge-PR high-level review takes precedence over lens splitting", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: true, huge_pr_token_threshold: 1 },
      changeDescription: "t",
      useContext: false,
    });

    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(mockedCall.mock.calls[0][0].system).toBe(HIGH_LEVEL_SYSTEM_PROMPT);
    expect(result.highLevelReview).toBe(true);
    expect(result.stats.lensStats).toBeUndefined();
  });
});

describe("reviewBrief", () => {
  it("assembles files/blastRadius/signals/totalTokens deterministically from Phase A/B output", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "t",
      useContext: false,
    });

    expect(result.reviewBrief.files).toEqual(["src/a.ts"]);
    expect(result.reviewBrief.blastRadius).toEqual([]);
    expect(result.reviewBrief.signals).toEqual([]);
    expect(result.reviewBrief.totalTokens).toBeGreaterThan(0);
  });
});
