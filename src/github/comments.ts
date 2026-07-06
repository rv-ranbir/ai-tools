import type { Octokit } from "@octokit/rest";
import type { PrRef } from "../diff/github.js";
import type { Finding, ReviewResult, Severity } from "../types.js";

export const AGENT_MARKER = "<!-- pr-review-agent -->";

export const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🟥",
  high: "🔴",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

export function formatCommentBody(f: Finding): string {
  const parts = [
    `${SEVERITY_EMOJI[f.severity]} **${f.severity.toUpperCase()}** · \`${f.category}\` · confidence ${Math.round(f.confidence * 100)}%`,
    "",
    `**${f.title}**`,
    "",
    f.body.trim(),
  ];
  if (f.suggestion) {
    parts.push("", "```suggestion", f.suggestion.replace(/\n$/, ""), "```");
  }
  parts.push("", AGENT_MARKER);
  return parts.join("\n");
}

export function formatReviewBody(result: ReviewResult, failed: boolean): string {
  const counts = countBySeverity(result.findings);
  const countLine =
    result.findings.length === 0
      ? "No findings."
      : Object.entries(counts)
          .map(([sev, n]) => `${SEVERITY_EMOJI[sev as Severity]} ${n} ${sev}`)
          .join(" · ");
  return [
    `## PR Review Agent`,
    "",
    result.summary.trim(),
    "",
    countLine,
    failed ? "\n❌ **Check failed**: findings at or above the configured severity threshold." : "",
    AGENT_MARKER,
  ].join("\n");
}

function countBySeverity(findings: Finding[]): Partial<Record<Severity, number>> {
  const counts: Partial<Record<Severity, number>> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

export interface PostReviewOptions {
  octokit: Octokit;
  pr: PrRef;
  headSha: string;
  result: ReviewResult;
  failed: boolean;
  log?: (msg: string) => void;
}

/**
 * Post all findings as one PR review with inline comments on the changed lines.
 * Findings whose position GitHub rejects fall back into the review body.
 * Duplicate comments from a previous run (same file/line/title) are skipped.
 */
export async function postReview(opts: PostReviewOptions): Promise<void> {
  const { octokit, pr, result, log = () => {} } = opts;

  const existing = await octokit.paginate(octokit.pulls.listReviewComments, {
    ...pr,
    per_page: 100,
  });
  const existingKeys = new Set(
    existing
      .filter((c) => c.body.includes(AGENT_MARKER))
      .map((c) => `${c.path}:${c.line ?? c.original_line}:${firstTitle(c.body)}`),
  );

  const comments = [];
  const skipped: Finding[] = [];
  for (const f of result.findings) {
    if (existingKeys.has(`${f.file}:${f.end_line}:${f.title}`)) {
      skipped.push(f);
      continue;
    }
    comments.push({
      path: f.file,
      line: f.end_line,
      ...(f.end_line > f.start_line ? { start_line: f.start_line, start_side: "RIGHT" as const } : {}),
      side: "RIGHT" as const,
      body: formatCommentBody(f),
    });
  }
  if (skipped.length) log(`Skipping ${skipped.length} comment(s) already posted by a previous run.`);

  const body = formatReviewBody(result, opts.failed);

  try {
    await octokit.pulls.createReview({
      ...pr,
      commit_id: opts.headSha,
      event: "COMMENT",
      body,
      comments,
    });
    log(`Posted review with ${comments.length} inline comment(s).`);
  } catch (err) {
    // Most common failure: one comment's position rejected. Retry with body-only
    // review that lists all findings, so results are never silently lost.
    log(`Inline review failed (${(err as Error).message}); posting summary-only review.`);
    const fallbackBody = [
      body,
      "",
      "### Findings (inline placement failed)",
      ...result.findings.map(
        (f) => `- **${f.severity}** \`${f.file}:${f.start_line}-${f.end_line}\` — ${f.title}\n\n  ${f.body.split("\n").join("\n  ")}`,
      ),
    ].join("\n");
    await octokit.pulls.createReview({
      ...pr,
      commit_id: opts.headSha,
      event: "COMMENT",
      body: fallbackBody,
    });
  }
}

function firstTitle(body: string): string {
  const m = /\*\*(.+?)\*\*/g;
  // First bold run is the severity label; second is the title.
  m.exec(body);
  const second = m.exec(body);
  return second?.[1] ?? "";
}
