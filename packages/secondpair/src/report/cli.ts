import pc from "picocolors";
import { severityRank, type Finding, type ReviewResult, type Severity } from "../types.js";

const SEVERITY_LABEL: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.bgRed(pc.white(` ${s.toUpperCase()} `)),
  high: (s) => pc.red(s.toUpperCase()),
  medium: (s) => pc.yellow(s.toUpperCase()),
  low: (s) => pc.cyan(s.toUpperCase()),
  info: (s) => pc.dim(s.toUpperCase()),
};

export function formatReport(result: ReviewResult): string {
  const lines: string[] = [];

  lines.push(pc.bold("PR Review"));
  lines.push("");
  lines.push(result.summary.trim());
  lines.push("");

  if (result.findings.length === 0) {
    lines.push(pc.green("✓ No findings."));
    return lines.join("\n");
  }

  const byFile = new Map<string, Finding[]>();
  for (const f of result.findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }

  for (const [file, findings] of byFile) {
    lines.push(pc.bold(pc.underline(file)));
    for (const f of findings) {
      const range = f.start_line === f.end_line ? `L${f.start_line}` : `L${f.start_line}-${f.end_line}`;
      lines.push(
        `  ${SEVERITY_LABEL[f.severity](f.severity)} ${pc.dim(`[${f.category}]`)} ${pc.dim(range)} ${f.title} ${pc.dim(`(${Math.round(f.confidence * 100)}%)`)}`,
      );
      for (const bodyLine of f.body.trim().split("\n")) {
        lines.push(`      ${bodyLine}`);
      }
      if (f.suggestion) {
        lines.push(pc.dim("      suggestion:"));
        for (const s of f.suggestion.split("\n")) lines.push(pc.green(`      + ${s}`));
      }
      lines.push("");
    }
  }

  lines.push(summaryCounts(result.findings));
  if (result.reconciliation) {
    const r = result.reconciliation;
    lines.push(
      pc.dim(
        `lifecycle: ${r.new.length} new · ${r.persistent.length} persistent · ${r.resolved.length} resolved · ${r.suppressed.length} suppressed`,
      ),
    );
  }
  return lines.join("\n");
}

export function summaryCounts(findings: Finding[]): string {
  const counts = new Map<Severity, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
    .map(([sev, n]) => `${n} ${sev}`);
  return pc.bold(`${findings.length} finding(s): ${parts.join(", ")}`);
}

/** True when any finding meets or exceeds the fail_on severity threshold. */
export function shouldFail(findings: Finding[], failOn: Severity): boolean {
  const threshold = severityRank(failOn);
  return findings.some((f) => severityRank(f.severity) <= threshold);
}
