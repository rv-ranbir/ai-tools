import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Finding } from "../src/types.js";

vi.mock("repocairn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("repocairn")>()),
  structuredCall: vi.fn(),
  getModel: () => "mock-model",
}));

import { structuredCall } from "repocairn";
import { CRITIQUE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT } from "../src/llm/prompt.js";
import { capFindings, runReview } from "../src/review.js";

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

const REDACTION_DIFF = `diff --git a/src/config.ts b/src/config.ts
index 1111111..2222222 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -0,0 +1,3 @@
+export const aws = "AKIAIOSFODNN7EXAMPLE";
+export const api = "sk-abc123DEF456ghi789jkl";
+export const internal = "INTERNAL_SECRET_42";
`;

function fakeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/math.ts",
    start_line: 2,
    end_line: 3,
    severity: "high",
    category: "bug",
    confidence: 0.9,
    title: `finding ${Math.random()}`,
    body: "x",
    suggestion: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockedCall.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("prompt rules", () => {
  it("instructs the model to cite diff evidence or lower severity when context disagrees", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("cite the specific added lines");
    expect(REVIEW_SYSTEM_PROMPT).toContain("lower the severity and confidence");
  });
});

describe("capFindings", () => {
  it("caps per file, dropping lowest confidence first", () => {
    const group = [0.9, 0.3, 0.8, 0.5, 0.7, 0.6, 0.95].map((confidence, i) =>
      fakeFinding({ confidence, title: `t${i}` }),
    );
    const { kept, capped } = capFindings(group, { max_findings_per_file: 5, max_total: 30 });
    expect(kept).toHaveLength(5);
    expect(capped.map((f) => f.confidence).sort()).toEqual([0.3, 0.5]);
  });

  it("enforces the global total across files", () => {
    const findings = Array.from({ length: 8 }, (_, i) =>
      fakeFinding({ file: `src/f${i}.ts`, confidence: 0.5 + i * 0.05, title: `t${i}` }),
    );
    const { kept, capped } = capFindings(findings, { max_findings_per_file: 5, max_total: 6 });
    expect(kept).toHaveLength(6);
    expect(capped).toHaveLength(2);
    expect(Math.max(...capped.map((f) => f.confidence))).toBeLessThan(
      Math.min(...kept.map((f) => f.confidence)),
    );
  });

  it("severity breaks confidence ties (less severe dropped first)", () => {
    const findings = [
      fakeFinding({ severity: "info", confidence: 0.9, title: "a" }),
      fakeFinding({ severity: "critical", confidence: 0.9, title: "b" }),
    ];
    const { kept } = capFindings(findings, { max_findings_per_file: 1, max_total: 30 });
    expect(kept[0].severity).toBe("critical");
  });
});

describe("temperature and stats", () => {
  it("passes the configured temperature and default when unset", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "t",
      useContext: false,
    });
    expect(mockedCall.mock.calls[0][0].temperature).toBeUndefined();

    await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, temperature: 0 },
      changeDescription: "t",
      useContext: false,
    });
    expect(mockedCall.mock.calls[1][0].temperature).toBe(0);
  });

  it("aggregates usage and counts into stats", async () => {
    mockedCall.mockImplementation(async (opts: { onUsage?: (u: { inputTokens: number; outputTokens: number }) => void }) => {
      opts.onUsage?.({ inputTokens: 100, outputTokens: 20 });
      return { summary: "s", findings: [fakeFinding({ title: "stable title" })] };
    });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "t",
      useContext: false,
    });

    expect(result.stats.model).toBe("mock-model");
    expect(result.stats.llmCalls).toBe(1);
    expect(result.stats.inputTokens).toBe(100);
    expect(result.stats.outputTokens).toBe(20);
    expect(result.stats.findingsBySeverity.high).toBe(1);
    expect(result.stats.droppedValidation).toBe(0);
  });
});

describe("prompt redaction", () => {
  it("redacts built-in and configured secrets before sending the diff to the LLM", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    await runReview({
      cwd: process.cwd(),
      diffText: REDACTION_DIFF,
      config: { ...DEFAULT_CONFIG, redact_patterns: ["INTERNAL_SECRET_\\d+"] },
      changeDescription: "t",
      useContext: false,
    });

    const user = mockedCall.mock.calls[0][0].user as string;
    expect(user).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(user).not.toContain("sk-abc123DEF456ghi789jkl");
    expect(user).not.toContain("INTERNAL_SECRET_42");
    expect(user).toContain("[REDACTED]");
  });

  it("leaves secrets unchanged when redaction is disabled", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    await runReview({
      cwd: process.cwd(),
      diffText: REDACTION_DIFF,
      config: { ...DEFAULT_CONFIG, redact_secrets: false },
      changeDescription: "t",
      useContext: false,
    });

    const user = mockedCall.mock.calls[0][0].user as string;
    expect(user).toContain("AKIAIOSFODNN7EXAMPLE");
    expect(user).toContain("sk-abc123DEF456ghi789jkl");
  });
});

describe("self-critique", () => {
  it("drops findings absent from keep_ids and never adds", async () => {
    mockedCall
      .mockResolvedValueOnce({
        summary: "s",
        findings: [fakeFinding({ title: "keep me" }), fakeFinding({ title: "drop me", start_line: 3, end_line: 3 })],
      })
      .mockImplementationOnce(async (opts: { system: string; user: string }) => {
        expect(opts.system).toBe(CRITIQUE_SYSTEM_PROMPT);
        const keepId = /id: ([a-f0-9]+)\n\s+location: [^\n]*\n\s+title: keep me/.exec(opts.user)?.[1];
        expect(keepId).toBeTruthy();
        return { keep_ids: [keepId] };
      });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, self_critique: true },
      changeDescription: "t",
      useContext: false,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("keep me");
    expect(result.stats.droppedCritique).toBe(1);
    expect(result.stats.llmCalls).toBe(2);
  });

  it("treats an empty keep list as a misfire and keeps everything", async () => {
    mockedCall
      .mockResolvedValueOnce({ summary: "s", findings: [fakeFinding({ title: "issue one" }), fakeFinding({ title: "issue two", start_line: 3, end_line: 3 })] })
      .mockResolvedValueOnce({ keep_ids: [] });

    const result = await runReview({
      cwd: process.cwd(),
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, self_critique: true },
      changeDescription: "t",
      useContext: false,
    });

    expect(result.findings).toHaveLength(2);
    expect(result.stats.droppedCritique).toBe(0);
  });
});

describe("context snippets", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-review-snip-"));
    await fs.mkdir(path.join(dir, ".repocairn"), { recursive: true });
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "math.ts"), "export function sum() {}\n");
    await fs.writeFile(
      path.join(dir, "src", "app.ts"),
      "import { sum } from './math';\nexport const APP_SENTINEL = sum;\n",
    );
    const index = {
      version: 1,
      generatedAt: new Date().toISOString(),
      files: {
        "src/math.ts": { symbols: ["export function sum"], imports: [], summary: "adds numbers" },
        "src/app.ts": {
          symbols: ["export const APP_SENTINEL"],
          imports: ["src/math.ts"],
          summary: "app entry",
        },
      },
    };
    await fs.writeFile(path.join(dir, ".repocairn", "index.json"), JSON.stringify(index));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("inlines related-file source into the prompt within limits", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    await runReview({
      cwd: dir,
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "t",
    });

    const user = mockedCall.mock.calls[0][0].user as string;
    expect(user).toContain("full source");
    expect(user).toContain("APP_SENTINEL");
  });

  it("context_snippets: 0 disables snippets", async () => {
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    await runReview({
      cwd: dir,
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, context_snippets: 0 },
      changeDescription: "t",
    });

    const user = mockedCall.mock.calls[0][0].user as string;
    expect(user).not.toContain("full source");
    // symbol names still appear via the summaries/symbols context — only raw source is gone
    expect(user).not.toContain("import { sum } from './math'");
  });

  it("redacts secrets from repository context before sending it to the LLM", async () => {
    await fs.writeFile(
      path.join(dir, "src", "app.ts"),
      "export const API_KEY = 'sk-abc123DEF456ghi789jkl';\n",
    );
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    await runReview({
      cwd: dir,
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG },
      changeDescription: "t",
    });

    const user = mockedCall.mock.calls[0][0].user as string;
    expect(user).not.toContain("sk-abc123DEF456ghi789jkl");
    expect(user).toContain("[REDACTED]");
  });
});
