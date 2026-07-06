import { z } from "zod";
import type { FileDiff, Finding, ReviewConfig, ReviewResult } from "../types.js";

export const findingSchema = z.object({
  file: z.string().describe("Repo-relative path of the file the finding is in"),
  start_line: z.number().int().describe("First affected line (new-file line numbers)"),
  end_line: z.number().int().describe("Last affected line (inclusive)"),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  category: z.enum(["bug", "security", "missing-tests", "naming", "complexity", "custom"]),
  confidence: z.number().describe("Self-rated confidence between 0 and 1"),
  title: z.string().describe("One-line summary of the issue"),
  body: z.string().describe("Markdown explanation with reasoning and impact"),
  suggestion: z
    .string()
    .nullable()
    .describe(
      "Replacement code for exactly the start_line..end_line range, or null. Must be complete lines with correct indentation.",
    ),
});

export const reviewOutputSchema = z.object({
  summary: z.string().describe("2-4 sentence overall assessment of the change"),
  findings: z.array(findingSchema),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/**
 * Post-validate model findings against the diff and config.
 * Drops findings on files/lines outside the diff, below the confidence floor,
 * or in disabled categories. Line ranges that merely overlap the changed lines
 * are clamped rather than dropped.
 */
export function validateFindings(
  raw: ReviewOutput,
  files: FileDiff[],
  config: ReviewConfig,
): ReviewResult {
  const changedByFile = new Map<string, Set<number>>(
    files.map((f) => [f.path, new Set(f.changedLines)]),
  );

  const findings: Finding[] = [];
  const dropped: Finding[] = [];

  for (const f of raw.findings) {
    const finding: Finding = { ...f, confidence: clamp01(f.confidence) };

    if (config.categories[finding.category] === false) {
      dropped.push(finding);
      continue;
    }
    if (finding.confidence < config.min_confidence) {
      dropped.push(finding);
      continue;
    }
    const changed = changedByFile.get(finding.file);
    if (!changed || changed.size === 0) {
      dropped.push(finding);
      continue;
    }
    // Clamp the range onto changed lines; drop when there is no overlap.
    const inRange = [...changed].filter(
      (l) => l >= finding.start_line && l <= finding.end_line,
    );
    if (inRange.length === 0) {
      dropped.push(finding);
      continue;
    }
    const start = Math.min(...inRange);
    const end = Math.max(...inRange);
    if (start !== finding.start_line || end !== finding.end_line) {
      // Suggestions are only valid for the exact original range.
      if (finding.suggestion) finding.suggestion = null;
      finding.start_line = start;
      finding.end_line = end;
    }
    findings.push(finding);
  }

  findings.sort(
    (a, b) =>
      severityOrder(a.severity) - severityOrder(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.start_line - b.start_line,
  );

  return { findings, summary: raw.summary, dropped };
}

function severityOrder(s: Finding["severity"]): number {
  return ["critical", "high", "medium", "low", "info"].indexOf(s);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
