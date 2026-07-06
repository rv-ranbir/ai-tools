import { describe, expect, it } from "vitest";
import { shouldFail, formatReport } from "../src/report/cli.js";
import type { Finding, ReviewResult } from "../src/types.js";

function finding(severity: Finding["severity"]): Finding {
  return {
    file: "src/a.ts",
    start_line: 1,
    end_line: 1,
    severity,
    category: "bug",
    confidence: 0.9,
    title: `${severity} issue`,
    body: "details",
    suggestion: null,
  };
}

describe("shouldFail", () => {
  it("fails when a finding meets the threshold exactly", () => {
    expect(shouldFail([finding("high")], "high")).toBe(true);
  });
  it("fails when a finding exceeds the threshold", () => {
    expect(shouldFail([finding("critical")], "high")).toBe(true);
  });
  it("passes when all findings are below the threshold", () => {
    expect(shouldFail([finding("medium"), finding("low")], "high")).toBe(false);
  });
  it("passes with no findings", () => {
    expect(shouldFail([], "info")).toBe(false);
  });
  it("threshold info fails on anything", () => {
    expect(shouldFail([finding("info")], "info")).toBe(true);
  });
});

describe("formatReport", () => {
  it("groups findings by file with severity counts", () => {
    const result: ReviewResult = {
      summary: "Two problems found.",
      findings: [finding("critical"), finding("low")],
      dropped: [],
    };
    const text = formatReport(result);
    expect(text).toContain("Two problems found.");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("critical issue");
    expect(text).toContain("2 finding(s): 1 critical, 1 low");
  });

  it("reports success when there are no findings", () => {
    const text = formatReport({ summary: "Looks good.", findings: [], dropped: [] });
    expect(text).toContain("No findings");
  });
});
