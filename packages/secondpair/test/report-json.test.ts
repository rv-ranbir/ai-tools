import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildJsonReport,
  formatRunSummaryLine,
  loadPreviousFindings,
  loadPreviousIds,
  writeJsonReport,
} from "../src/report/json.js";
import type { Finding, ReviewResult, RunStats } from "../src/types.js";

let dir: string;
let reportPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-review-json-"));
  reportPath = path.join(dir, "pr-review-report.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function fakeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    start_line: 1,
    end_line: 1,
    severity: "high",
    category: "bug",
    confidence: 0.9,
    title: "t",
    body: "b",
    suggestion: null,
    id: "abc123",
    ...overrides,
  };
}

describe("loadPreviousIds / loadPreviousFindings — missing report (first run)", () => {
  it("return empty, do not throw", async () => {
    expect(await loadPreviousIds(reportPath)).toEqual(new Set());
    expect(await loadPreviousFindings(reportPath)).toEqual([]);
  });
});

describe("loadPreviousIds / loadPreviousFindings — corrupt report", () => {
  it("treats truncated JSON (crashed mid-write) as empty rather than throwing", async () => {
    await fs.writeFile(reportPath, '{"findings": [{"id": "x1"');
    expect(await loadPreviousIds(reportPath)).toEqual(new Set());
    expect(await loadPreviousFindings(reportPath)).toEqual([]);
  });
});

describe("loadPreviousFindings — malformed entries", () => {
  it("filters out findings missing required fields", async () => {
    await fs.writeFile(
      reportPath,
      JSON.stringify({
        findings: [
          fakeFinding({ id: "good1" }),
          { file: "src/b.ts" }, // missing id/category/title
          { ...fakeFinding({ id: "good2" }), title: undefined },
        ],
      }),
    );
    const findings = await loadPreviousFindings(reportPath);
    expect(findings.map((f) => f.id)).toEqual(["good1"]);
  });
});

describe("loadPreviousIds — reconciliation ids merged with finding ids", () => {
  it("collects ids from both the findings array and reconciliation buckets, lowercased", async () => {
    await fs.writeFile(
      reportPath,
      JSON.stringify({
        findings: [fakeFinding({ id: "FromFinding" })],
        reconciliation: { new: ["FromNew"], persistent: ["FromPersistent"] },
      }),
    );
    const ids = await loadPreviousIds(reportPath);
    expect(ids).toEqual(new Set(["fromfinding", "fromnew", "frompersistent"]));
  });
});

describe("buildJsonReport / writeJsonReport", () => {
  it("round-trips through disk", async () => {
    const stats: RunStats = {
      model: "m",
      llmCalls: 1,
      inputTokens: 10,
      outputTokens: 5,
      findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      droppedValidation: 0,
      droppedCaps: 0,
      droppedDuplicates: 0,
      droppedCritique: 0,
      suppressed: 0,
      persistent: 0,
    };
    const result: ReviewResult & { stats: RunStats } = {
      findings: [fakeFinding()],
      summary: "did a thing",
      dropped: [],
      reconciliation: { new: ["abc123"], persistent: [], resolved: [], suppressed: [] },
      findingsToPost: [fakeFinding()],
      stats,
    };
    const report = buildJsonReport(result, {
      model: "m",
      changeDescription: "PR #1",
      usedContext: true,
    });
    await writeJsonReport(reportPath, report);

    const onDisk = JSON.parse(await fs.readFile(reportPath, "utf8"));
    expect(onDisk.summary).toBe("did a thing");
    expect(onDisk.findings).toHaveLength(1);
    expect(onDisk.meta.changeDescription).toBe("PR #1");
    expect(onDisk.meta.usedContext).toBe(true);
    expect(onDisk.stats.llmCalls).toBe(1);

    // And the file this just wrote round-trips through the loaders too.
    const ids = await loadPreviousIds(reportPath);
    expect(ids).toContain("abc123");
  });
});

describe("formatRunSummaryLine", () => {
  it("emits a single parseable JSON line prefixed for CI log scraping", () => {
    const stats: RunStats = {
      model: "m",
      llmCalls: 2,
      inputTokens: 1,
      outputTokens: 1,
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      droppedValidation: 0,
      droppedCaps: 0,
      droppedDuplicates: 0,
      droppedCritique: 0,
      suppressed: 0,
      persistent: 0,
    };
    const line = formatRunSummaryLine(stats);
    expect(line.startsWith("pr-review-summary ")).toBe(true);
    expect(JSON.parse(line.slice("pr-review-summary ".length))).toEqual(stats);
  });
});
