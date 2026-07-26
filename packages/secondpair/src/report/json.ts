import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Finding, Reconciliation, ReviewResult, RunStats } from "../types.js";

export interface JsonReport {
  meta: {
    generatedAt: string;
    model: string;
    changeDescription: string;
    usedContext: boolean;
  };
  summary: string;
  findings: ReviewResult["findings"];
  reconciliation?: Reconciliation;
  stats?: RunStats;
}

export function buildJsonReport(
  result: ReviewResult & { stats?: RunStats },
  meta: { model: string; changeDescription: string; usedContext: boolean },
): JsonReport {
  return {
    meta: { generatedAt: new Date().toISOString(), ...meta },
    summary: result.summary,
    findings: result.findings,
    reconciliation: result.reconciliation,
    stats: result.stats,
  };
}

/** One structured log line for CI parsing: counts, tokens, model. */
export function formatRunSummaryLine(stats: RunStats): string {
  return `pr-review-summary ${JSON.stringify(stats)}`;
}

export async function writeJsonReport(path: string, report: JsonReport): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}

/** Load finding ids from a previous pr-review-report.json if present. */
export async function loadPreviousIds(reportPath: string): Promise<Set<string>> {
  const findings = await loadPreviousFindings(reportPath);
  const ids = new Set<string>();
  for (const f of findings) {
    if (f.id) ids.add(f.id.toLowerCase());
  }
  if (!existsSync(reportPath)) return ids;
  try {
    const raw = JSON.parse(await readFile(reportPath, "utf8")) as {
      reconciliation?: { new?: string[]; persistent?: string[] };
    };
    for (const id of raw.reconciliation?.new ?? []) ids.add(id.toLowerCase());
    for (const id of raw.reconciliation?.persistent ?? []) ids.add(id.toLowerCase());
  } catch {
    /* ignore */
  }
  return ids;
}

/** Load prior findings (for soft-match reconcile when titles were rephrased). */
export async function loadPreviousFindings(reportPath: string): Promise<Finding[]> {
  if (!existsSync(reportPath)) return [];
  try {
    const raw = JSON.parse(await readFile(reportPath, "utf8")) as {
      findings?: Finding[];
    };
    return (raw.findings ?? []).filter((f) => f && f.id && f.file && f.category && f.title);
  } catch {
    return [];
  }
}
