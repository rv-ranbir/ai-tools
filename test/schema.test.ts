import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { validateFindings, type ReviewOutput } from "../src/llm/schema.js";
import type { FileDiff, ReviewConfig } from "../src/types.js";

const files: FileDiff[] = [
  {
    path: "src/a.ts",
    status: "modified",
    hunks: [],
    changedLines: [10, 11, 12, 30],
  },
];

function finding(overrides: Partial<ReviewOutput["findings"][number]> = {}) {
  return {
    file: "src/a.ts",
    start_line: 10,
    end_line: 11,
    severity: "high" as const,
    category: "bug" as const,
    confidence: 0.9,
    title: "Off-by-one",
    body: "Loop bound excludes the last element.",
    suggestion: null,
    ...overrides,
  };
}

const config: ReviewConfig = { ...DEFAULT_CONFIG };

describe("validateFindings", () => {
  it("keeps findings on changed lines", () => {
    const result = validateFindings({ summary: "s", findings: [finding()] }, files, config);
    expect(result.findings).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops findings on files not in the diff", () => {
    const result = validateFindings(
      { summary: "s", findings: [finding({ file: "src/other.ts" })] },
      files,
      config,
    );
    expect(result.findings).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
  });

  it("drops findings whose lines don't overlap changed lines", () => {
    const result = validateFindings(
      { summary: "s", findings: [finding({ start_line: 100, end_line: 105 })] },
      files,
      config,
    );
    expect(result.findings).toHaveLength(0);
  });

  it("clamps ranges that partially overlap changed lines and strips the suggestion", () => {
    const result = validateFindings(
      {
        summary: "s",
        findings: [finding({ start_line: 8, end_line: 11, suggestion: "fixed code" })],
      },
      files,
      config,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].start_line).toBe(10);
    expect(result.findings[0].end_line).toBe(11);
    expect(result.findings[0].suggestion).toBeNull();
  });

  it("drops findings below the confidence floor", () => {
    const result = validateFindings(
      { summary: "s", findings: [finding({ confidence: 0.2 })] },
      files,
      config,
    );
    expect(result.findings).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
  });

  it("drops findings in disabled categories", () => {
    const cfg: ReviewConfig = {
      ...config,
      categories: { ...config.categories, naming: false },
    };
    const result = validateFindings(
      { summary: "s", findings: [finding({ category: "naming" })] },
      files,
      cfg,
    );
    expect(result.findings).toHaveLength(0);
  });

  it("sorts findings by severity, then file, then line", () => {
    const result = validateFindings(
      {
        summary: "s",
        findings: [
          finding({ severity: "low", start_line: 10, end_line: 10, title: "low one" }),
          finding({ severity: "critical", start_line: 30, end_line: 30, title: "crit one" }),
        ],
      },
      files,
      config,
    );
    expect(result.findings.map((f) => f.severity)).toEqual(["critical", "low"]);
  });
});
