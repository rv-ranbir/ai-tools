import { describe, expect, it } from "vitest";
import {
  embedFindingId,
  findingsSoftMatch,
  fingerprintFinding,
  normalizeTitle,
  parseFindingId,
  titleSimilarity,
} from "../src/finding-id.js";
import { reconcileFindings } from "../src/reconcile.js";
import type { Finding } from "../src/types.js";

function f(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    start_line: 1,
    end_line: 2,
    severity: "high",
    category: "bug",
    confidence: 0.9,
    title: "Off-by-one in loop",
    body: "x",
    suggestion: null,
    ...overrides,
  };
}

describe("fingerprintFinding", () => {
  it("is stable across line number and punctuation churn", () => {
    const a = fingerprintFinding(f({ start_line: 10, title: "Off-by-one in loop!" }));
    const b = fingerprintFinding(f({ start_line: 99, title: "off by one in loop" }));
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("changes when file or category changes", () => {
    const base = fingerprintFinding(f());
    expect(fingerprintFinding(f({ file: "src/b.ts" }))).not.toBe(base);
    expect(fingerprintFinding(f({ category: "security" }))).not.toBe(base);
  });
});

describe("normalizeTitle", () => {
  it("collapses noise and drops stopwords", () => {
    expect(normalizeTitle("  Hello, World!! ")).toBe("hello world");
  });
});

describe("titleSimilarity + soft match (live thrash regression)", () => {
  it("matches rephrased off-by-one titles from live Cursor runs", () => {
    const a = "Off-by-one loop reads past end of array";
    const b = "Off-by-one loop includes xs[length]";
    expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(0.3);
    expect(
      findingsSoftMatch(
        f({ title: a, start_line: 3, end_line: 3, file: "src/math.ts" }),
        f({ title: b, start_line: 3, end_line: 3, file: "src/math.ts" }),
      ),
    ).toBe(true);
  });

  it("matches rephrased missing-tests titles", () => {
    expect(
      findingsSoftMatch(
        f({
          title: "No tests for rewritten sum loop",
          category: "missing-tests",
          start_line: 2,
          end_line: 4,
          file: "src/math.ts",
        }),
        f({
          title: "No tests for rewritten sum",
          category: "missing-tests",
          start_line: 2,
          end_line: 4,
          file: "src/math.ts",
        }),
      ),
    ).toBe(true);
  });

  it("does not match unrelated findings in the same file", () => {
    expect(
      findingsSoftMatch(
        f({ title: "Off-by-one in loop", category: "bug" }),
        f({ title: "SQL injection in query builder", category: "security" }),
      ),
    ).toBe(false);
  });

  it("matches despite a category flip when the title is near-identical (live thrash: bug -> security)", () => {
    expect(
      findingsSoftMatch(
        f({ title: "Unpinned npx executes external script", category: "bug", file: "src/ci.ts" }),
        f({ title: "Unpinned npx executes external script", category: "security", file: "src/ci.ts" }),
      ),
    ).toBe(true);
  });

  it("matches across large line-citation drift when the title is near-identical (live thrash: L188 vs L71)", () => {
    expect(
      findingsSoftMatch(
        f({
          title: "Graphify step duplicated in pipeline",
          file: "src/pipeline.yml",
          start_line: 188,
          end_line: 188,
        }),
        f({
          title: "Graphify step duplicated in pipeline",
          file: "src/pipeline.yml",
          start_line: 71,
          end_line: 71,
        }),
      ),
    ).toBe(true);
  });
});

describe("embed/parse finding id", () => {
  it("round-trips", () => {
    const body = embedFindingId("hello\n<!-- secondpair -->", "abc123def4567890");
    expect(parseFindingId(body)).toBe("abc123def4567890");
  });
});

describe("reconcileFindings", () => {
  it("classifies new, persistent, suppressed, resolved", () => {
    const id1 = fingerprintFinding(f({ title: "Issue one" }));
    const id2 = fingerprintFinding(f({ title: "Issue two" }));
    const id3 = fingerprintFinding(f({ title: "Gone soon" }));

    const current = [
      { ...f({ title: "Issue one" }), id: id1 },
      { ...f({ title: "Issue two" }), id: id2 },
      { ...f({ title: "Gone soon" }), id: id3 },
    ];
    const result = reconcileFindings(current, {
      previousIds: [id1, "deadbeefdeadbeef"],
      suppressedIds: [id3],
    });

    expect(result.reconciliation.persistent).toContain(id1);
    expect(result.reconciliation.new).toContain(id2);
    expect(result.reconciliation.suppressed).toContain(id3);
    expect(result.reconciliation.resolved).toContain("deadbeefdeadbeef");
    expect(result.active.map((x) => x.id)).toEqual([id1, id2]);
    expect(result.toPost.map((x) => x.id)).toEqual([id2]);
  });

  it("soft-matches rephrased titles and reuses the previous id", () => {
    const priorId = "446c13ab9591a1bf";
    const current = [
      {
        ...f({
          file: "src/math.ts",
          title: "Off-by-one loop includes xs[length]",
          start_line: 3,
          end_line: 3,
        }),
        id: fingerprintFinding(
          f({ file: "src/math.ts", title: "Off-by-one loop includes xs[length]" }),
        ),
      },
    ];
    const result = reconcileFindings(current, {
      previousFindings: [
        {
          id: priorId,
          file: "src/math.ts",
          category: "bug",
          title: "Off-by-one loop reads past end of array",
          start_line: 3,
          end_line: 3,
        },
      ],
    });
    expect(result.reconciliation.persistent).toEqual([priorId]);
    expect(result.reconciliation.new).toEqual([]);
    expect(result.reconciliation.resolved).toEqual([]);
    expect(result.active[0].id).toBe(priorId);
    expect(result.toPost).toHaveLength(0);
  });

  it("does not mark retained ids as resolved when absent from current output", () => {
    const retainedId = "aabbccddeeff0011";
    const result = reconcileFindings([], {
      previousIds: [retainedId, "deadbeefdeadbeef"],
      retainedIds: [retainedId],
    });
    expect(result.reconciliation.resolved).toEqual(["deadbeefdeadbeef"]);
    expect(result.reconciliation.resolved).not.toContain(retainedId);
  });
});
