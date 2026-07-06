export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Lower index = more severe. */
export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export type Category =
  | "bug"
  | "security"
  | "missing-tests"
  | "naming"
  | "complexity"
  | "custom";

export const CATEGORIES: Category[] = [
  "bug",
  "security",
  "missing-tests",
  "naming",
  "complexity",
  "custom",
];

export interface Finding {
  file: string;
  /** New-file line numbers (side RIGHT of the diff). */
  start_line: number;
  end_line: number;
  severity: Severity;
  category: Category;
  /** Model self-rated confidence, 0..1. */
  confidence: number;
  title: string;
  /** Markdown explanation. */
  body: string;
  /** Optional replacement code for exactly the start_line..end_line range. */
  suggestion?: string | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw hunk lines including the leading ' ', '+', '-' or '\' character. */
  lines: string[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileDiff {
  /** New path (or old path for deletions). */
  path: string;
  oldPath?: string;
  status: FileStatus;
  hunks: Hunk[];
  /** New-file line numbers that were added or modified — the commentable lines. */
  changedLines: number[];
}

export interface ReviewConfig {
  fail_on: Severity;
  min_confidence: number;
  ignore: string[];
  context_token_budget: number;
  custom_instructions: string;
  categories: Record<Category, boolean>;
}

export interface ReviewResult {
  findings: Finding[];
  /** Model's overall summary of the change. */
  summary: string;
  /** Findings the model produced that were dropped by post-validation. */
  dropped: Finding[];
}
