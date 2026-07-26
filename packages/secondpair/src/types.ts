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
  /** Stable fingerprint (file|category|normalized title). Set after validation. */
  id?: string;
}

export interface Reconciliation {
  new: string[];
  persistent: string[];
  resolved: string[];
  suppressed: string[];
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
  /** Number of related files whose exact source is inlined into the prompt (0 disables). */
  context_snippets: number;
  custom_instructions: string;
  categories: Record<Category, boolean>;
  /** Sampling temperature; null = provider default (openai-compat: 0; anthropic: adaptive thinking). */
  temperature: number | null;
  limits: {
    max_findings_per_file: number;
    max_total: number;
  };
  /** Second drop-only LLM pass that removes findings the model would walk back. */
  self_critique: boolean;
  redact_secrets: boolean;
  redact_patterns: string[];
  write_suppressions: boolean;
}

export interface RunStats {
  model: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  findingsBySeverity: Record<Severity, number>;
  droppedValidation: number;
  droppedCaps: number;
  droppedDuplicates: number;
  droppedCritique: number;
  suppressed: number;
  persistent: number;
}

export interface ReviewResult {
  findings: Finding[];
  /** Model's overall summary of the change. */
  summary: string;
  /** Findings the model produced that were dropped by post-validation. */
  dropped: Finding[];
  /** Lifecycle vs previous run / PR comments / suppressions. */
  reconciliation?: Reconciliation;
  /** Subset of findings that should be newly posted to the PR. */
  findingsToPost?: Finding[];
}
