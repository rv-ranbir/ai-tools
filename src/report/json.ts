import { writeFile } from "node:fs/promises";
import type { ReviewResult } from "../types.js";

export interface JsonReport {
  meta: {
    generatedAt: string;
    model: string;
    changeDescription: string;
    usedContext: boolean;
  };
  summary: string;
  findings: ReviewResult["findings"];
}

export function buildJsonReport(
  result: ReviewResult,
  meta: { model: string; changeDescription: string; usedContext: boolean },
): JsonReport {
  return {
    meta: { generatedAt: new Date().toISOString(), ...meta },
    summary: result.summary,
    findings: result.findings,
  };
}

export async function writeJsonReport(path: string, report: JsonReport): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}
