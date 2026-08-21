import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

// Mock repocairn's LLM client — tests never hit a real API.
vi.mock("repocairn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("repocairn")>()),
  structuredCall: vi.fn(),
  getModel: () => "mock-model",
  resolveProvider: () => ({ provider: "anthropic", model: "mock-model", baseUrl: "", apiKey: "" }),
}));

import { structuredCall } from "repocairn";
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
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "test diff",
      useContext: false,
    });

    expect(mockedCall).toHaveBeenCalledTimes(1);
    const callArg = mockedCall.mock.calls[0][0];
    expect(callArg.user).toContain("src/math.ts");
    expect(callArg.user).toContain("i <= xs.length");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toContain("past the end");
    expect(result.findings[0].id).toBeTruthy();
    expect(result.reconciliation?.new).toHaveLength(1);
    expect(result.findingsToPost).toHaveLength(1);
    expect(result.dropped).toHaveLength(1);
    expect(result.usedContext).toBe(false);
  });

  it("marks findings persistent when previousIds match", async () => {
    mockedCall.mockResolvedValueOnce({
      summary: "same",
      findings: [
        {
          file: "src/math.ts",
          start_line: 2,
          end_line: 3,
          severity: "high",
          category: "bug",
          confidence: 0.95,
          title: "Loop reads past the end of the array",
          body: "x",
          suggestion: null,
        },
      ],
    });
    const first = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "test",
      useContext: false,
    });
    const id = first.findings[0].id!;
    mockedCall.mockResolvedValueOnce({
      summary: "same again",
      findings: [
        {
          file: "src/math.ts",
          start_line: 2,
          end_line: 3,
          severity: "high",
          category: "bug",
          confidence: 0.95,
          title: "Loop reads past the end of the array",
          body: "x",
          suggestion: null,
        },
      ],
    });
    const second = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "test",
      useContext: false,
      previousIds: [id],
    });
    expect(second.reconciliation?.persistent).toContain(id);
    expect(second.findingsToPost).toHaveLength(0);
  });

  it("does not re-post when the LLM rephrases the same finding on a repeat run", async () => {
    // Run 1
    mockedCall.mockResolvedValueOnce({
      summary: "run 1",
      findings: [
        {
          file: "src/math.ts",
          start_line: 2,
          end_line: 3,
          severity: "high",
          category: "bug",
          confidence: 0.95,
          title: "Off-by-one loop reads past end of array",
          body: "x",
          suggestion: null,
        },
      ],
    });
    const run1 = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "test",
      useContext: false,
    });
    expect(run1.findingsToPost).toHaveLength(1);

    // Run 2: same diff, but the LLM rewords the title (non-determinism) —
    // caller feeds run 1's findings back in as previousFindings (e.g. loaded
    // from the previous pr-review-report.json, or PR comments).
    mockedCall.mockResolvedValueOnce({
      summary: "run 2",
      findings: [
        {
          file: "src/math.ts",
          start_line: 2,
          end_line: 3,
          severity: "high",
          category: "bug",
          confidence: 0.93,
          title: "Off-by-one loop includes xs[length]",
          body: "y",
          suggestion: null,
        },
      ],
    });
    const run2 = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "test",
      useContext: false,
      previousFindings: run1.findings,
    });
    expect(run2.reconciliation?.persistent).toEqual([run1.findings[0].id]);
    expect(run2.reconciliation?.new).toHaveLength(0);
    expect(run2.findingsToPost).toHaveLength(0);

    // Run 3: identical to run 2's wording — still stable, still nothing new.
    mockedCall.mockResolvedValueOnce({
      summary: "run 3",
      findings: [
        {
          file: "src/math.ts",
          start_line: 2,
          end_line: 3,
          severity: "high",
          category: "bug",
          confidence: 0.93,
          title: "Off-by-one loop includes xs[length]",
          body: "y",
          suggestion: null,
        },
      ],
    });
    const run3 = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "test",
      useContext: false,
      previousFindings: run2.findings,
    });
    expect(run3.findingsToPost).toHaveLength(0);
    expect(run3.reconciliation?.persistent).toEqual([run1.findings[0].id]);
  });

  it("dedupes the same bug when the LLM reports it twice in one response", async () => {
    // Same file/category/title reported twice in a single LLM response
    // (real models do this — e.g. once per symptom of the same root cause).
    const dupeFinding = {
      file: "src/math.ts",
      start_line: 2,
      end_line: 3,
      severity: "high" as const,
      category: "bug" as const,
      confidence: 0.95,
      title: "Loop reads past the end of the array",
      body: "x",
      suggestion: null,
    };
    mockedCall.mockResolvedValueOnce({
      summary: "dup",
      findings: [dupeFinding, { ...dupeFinding, body: "y", confidence: 0.99 }],
    });
    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "test",
      useContext: false,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findingsToPost).toHaveLength(1);
    // Keeps the higher-confidence copy of the two.
    expect(result.findings[0].confidence).toBe(0.99);
    expect(result.stats.droppedDuplicates).toBe(1);
    expect(result.dropped).toHaveLength(1);
  });

  it("carries forward findings for files untouched since the last review, without calling the LLM for them", async () => {
    const DIFF2 = `${DIFF}diff --git a/src/other.ts b/src/other.ts
index 1111111..2222222 100644
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,2 +1,2 @@
-old line
+new line
`;
    const carried = {
      file: "src/other.ts",
      start_line: 1,
      end_line: 2,
      severity: "medium" as const,
      category: "style" as const,
      confidence: 0.7,
      title: "Stale finding from an earlier commit",
      body: "z",
      id: "carried-id-1",
    };
    mockedCall.mockResolvedValueOnce({
      summary: "only math.ts re-analyzed",
      findings: [
        {
          file: "src/math.ts",
          start_line: 2,
          end_line: 3,
          severity: "high",
          category: "bug",
          confidence: 0.95,
          title: "Loop reads past the end of the array",
          body: "x",
          suggestion: null,
        },
      ],
    });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF2,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "test",
      useContext: false,
      previousIds: ["carried-id-1", "fixed-id-1"],
      changedFiles: new Set(["src/math.ts"]),
      carryForwardFindings: [carried],
    });

    expect(mockedCall).toHaveBeenCalledTimes(1);
    const callArg = mockedCall.mock.calls[0][0];
    expect(callArg.user).toContain("src/math.ts");
    expect(callArg.user).not.toContain("src/other.ts");

    const ids = result.findings.map((f) => f.id);
    expect(ids).toContain("carried-id-1");
    expect(result.findings).toHaveLength(2);
    expect(result.reconciliation?.persistent).toContain("carried-id-1");
    expect(result.reconciliation?.resolved).toEqual(["fixed-id-1"]);
    expect(result.reconciliation?.resolved).not.toContain("carried-id-1");
  });

  it("semantic_dedup reclassifies a reworded 'new' finding as persistent and skips reposting it", async () => {
    const priorFinding = {
      id: "prior-id-1",
      file: "src/math.ts",
      category: "bug" as const,
      title: "Totally unrelated wording that will not soft-match",
      start_line: 50,
      end_line: 51,
    };
    mockedCall.mockImplementation(async (opts: { schemaName?: string; user: string }) => {
      if (opts.schemaName === "dedup_output") {
        const m = /- id: (\S+)\n {2}location: src\/math\.ts/.exec(opts.user);
        return { duplicates: m ? [{ new_id: m[1], prior_id: "prior-id-1" }] : [] };
      }
      return {
        summary: "run",
        findings: [
          {
            file: "src/math.ts",
            start_line: 2,
            end_line: 3,
            severity: "high",
            category: "bug",
            confidence: 0.95,
            title: "Loop reads past the end of the array",
            body: "x",
            suggestion: null,
          },
        ],
      };
    });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false, semantic_dedup: true },
      changeDescription: "test",
      useContext: false,
      previousFindings: [priorFinding],
    });

    expect(result.reconciliation?.new).toHaveLength(0);
    expect(result.reconciliation?.persistent).toEqual([result.findings[0].id]);
    expect(result.findingsToPost).toHaveLength(0);
  });

  it("semantic_dedup only sends prior findings from files the new findings actually touch", async () => {
    const priorInFile = {
      id: "prior-id-1",
      file: "src/math.ts",
      category: "bug" as const,
      title: "Totally unrelated wording that will not soft-match",
      start_line: 50,
      end_line: 51,
    };
    const priorOtherFile = {
      id: "prior-id-2",
      file: "src/other.ts",
      category: "bug" as const,
      title: "Some other file's stale finding",
      start_line: 1,
      end_line: 1,
    };
    let dedupUserPrompt: string | undefined;
    mockedCall.mockImplementation(async (opts: { schemaName?: string; user: string }) => {
      if (opts.schemaName === "dedup_output") {
        dedupUserPrompt = opts.user;
        return { duplicates: [] };
      }
      return {
        summary: "run",
        findings: [
          {
            file: "src/math.ts",
            start_line: 2,
            end_line: 3,
            severity: "high",
            category: "bug",
            confidence: 0.95,
            title: "Loop reads past the end of the array",
            body: "x",
            suggestion: null,
          },
        ],
      };
    });

    await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false, semantic_dedup: true },
      changeDescription: "test",
      useContext: false,
      previousFindings: [priorInFile, priorOtherFile],
    });

    expect(dedupUserPrompt).toContain("prior-id-1");
    expect(dedupUserPrompt).not.toContain("prior-id-2");
  });

  it("skips the semantic_dedup LLM call entirely when no prior finding shares a file with the new ones", async () => {
    mockedCall.mockResolvedValueOnce({
      summary: "run",
      findings: [
        {
          file: "src/math.ts",
          start_line: 2,
          end_line: 3,
          severity: "high",
          category: "bug",
          confidence: 0.95,
          title: "Loop reads past the end of the array",
          body: "x",
          suggestion: null,
        },
      ],
    });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, parallel_agents: false, semantic_dedup: true },
      changeDescription: "test",
      useContext: false,
      previousFindings: [
        {
          id: "prior-id-2",
          file: "src/other.ts",
          category: "bug" as const,
          title: "Some other file's stale finding",
          start_line: 1,
          end_line: 1,
        },
      ],
    });

    expect(mockedCall).toHaveBeenCalledTimes(1); // review call only, no dedup call
    expect(result.findingsToPost).toHaveLength(1);
  });

  it("returns cleanly on a diff with only ignored files", async () => {
    const lockDiff = DIFF.replaceAll("src/math.ts", "package-lock.json");
    const result = await runReview({
      cwd: process.cwd(),
      diffText: lockDiff,
      config: { ...DEFAULT_CONFIG, parallel_agents: false },
      changeDescription: "test diff",
      useContext: false,
    });
    expect(mockedCall).not.toHaveBeenCalled();
    expect(result.findings).toEqual([]);
  });
});
