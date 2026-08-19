import type { Octokit } from "@octokit/rest";
import type { PrRef } from "../diff/github.js";
import { collectIdsFromBodies, embedFindingId, parseFindingId } from "../finding-id.js";
import { embedReviewState, parseReviewState, type ReviewState } from "../review-state.js";
import { collectWontFixIds } from "../suppress-signals.js";
import type { Finding, ReviewResult, Severity } from "../types.js";

// Reference-link definition, not an HTML comment: some renderers (Bitbucket)
// HTML-escape raw comments instead of hiding them, leaving `<!-- -->` visible
// in the rendered comment. `[label]: # (...)` is invisible everywhere.
export const AGENT_MARKER = "[secondpair]: # (agent marker)";

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
  let body = parts.join("\n");
  if (f.id) body = embedFindingId(body, f.id);
  return body;
}

export function formatReviewBody(
  result: ReviewResult & { highLevelReview?: boolean },
  failed: boolean,
  headSha?: string,
): string {
  const counts = countBySeverity(result.findings);
  const countLine =
    result.findings.length === 0
      ? "No findings."
      : Object.entries(counts)
          .map(([sev, n]) => `${SEVERITY_EMOJI[sev as Severity]} ${n} ${sev}`)
          .join(" · ");
  const highLevelLine = result.highLevelReview
    ? "\n⚠️ **Large diff** — high-level review only (critical/high severity). Consider splitting this PR."
    : "";
  const recon = result.reconciliation;
  const reconLine = recon
    ? `\n_Lifecycle:_ ${recon.new.length} new · ${recon.persistent.length} persistent · ${recon.resolved.length} resolved · ${recon.suppressed.length} suppressed`
    : "";
  let body = [
    `## PR Review Agent`,
    "",
    result.summary.trim(),
    "",
    countLine,
    highLevelLine,
    reconLine,
    failed ? "\n❌ **Check failed**: findings at or above the configured severity threshold." : "",
    AGENT_MARKER,
  ].join("\n");
  if (headSha) body = embedReviewState(body, { headSha, findings: result.findings });
  return body;
}

/**
 * Recover the full review state (head sha + every active finding) embedded
 * in the agent's most recent PR review body — the source of truth for
 * soft-match reconciliation and incremental (changed-files-only) re-review.
 */
export async function getReviewState(octokit: Octokit, pr: PrRef): Promise<ReviewState | null> {
  const reviews = await octokit.paginate(octokit.pulls.listReviews, { ...pr, per_page: 100 });
  const mine = reviews.filter((r) => r.body?.includes(AGENT_MARKER));
  for (let i = mine.length - 1; i >= 0; i--) {
    const state = parseReviewState(mine[i].body ?? "");
    if (state) return state;
  }
  return null;
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

/** Collect finding ids already posted on this PR by the agent. */
export async function listPostedFindingIds(octokit: Octokit, pr: PrRef): Promise<Set<string>> {
  const existing = await octokit.paginate(octokit.pulls.listReviewComments, {
    ...pr,
    per_page: 100,
  });
  return collectIdsFromBodies(
    existing.filter((c) => c.body.includes(AGENT_MARKER)).map((c) => c.body),
  );
}

export async function listWontFixFindingIds(
  octokit: Octokit,
  pr: PrRef,
): Promise<Set<string>> {
  const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
    ...pr,
    per_page: 100,
  });
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  return collectWontFixIds(
    comments.map((comment) => {
      const parent = comment.in_reply_to_id
        ? byId.get(comment.in_reply_to_id)
        : undefined;
      return {
        body: comment.body,
        isAgent: comment.body.includes(AGENT_MARKER),
        parentAgentId:
          parent?.body.includes(AGENT_MARKER) === true
            ? parseFindingId(parent.body)
            : null,
      };
    }),
  );
}

interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: { nodes: { body: string }[] };
}

/** Resolve unresolved review threads whose comments contain one of the finding ids. */
export async function resolveThreadsForIds(
  octokit: Octokit,
  pr: PrRef,
  ids: Iterable<string>,
  log: (msg: string) => void = () => {},
): Promise<number> {
  const wanted = new Set(Array.from(ids, (id) => id.toLowerCase()));
  if (wanted.size === 0) return 0;

  let threads: ReviewThread[];
  try {
    threads = [];
    let cursor: string | null = null;
    for (;;) {
      const data = (await octokit.graphql(
        `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
          repository(owner:$owner,name:$repo){
            pullRequest(number:$number){
              reviewThreads(first:100,after:$cursor){
                nodes{id isResolved comments(first:100){nodes{body}}}
                pageInfo{hasNextPage endCursor}
              }
            }
          }
        }`,
        { owner: pr.owner, repo: pr.repo, number: pr.pull_number, cursor },
      )) as {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: ReviewThread[];
              pageInfo?: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
      const page = data.repository?.pullRequest?.reviewThreads;
      threads.push(...(page?.nodes ?? []));
      if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
      cursor = page.pageInfo.endCursor;
    }
  } catch (err) {
    log(`warn: failed to list GitHub review threads: ${(err as Error).message}`);
    return 0;
  }

  let resolved = 0;
  for (const thread of threads) {
    if (
      thread.isResolved ||
      !thread.comments.nodes.some((comment) => {
        const id = parseFindingId(comment.body);
        return id != null && wanted.has(id.toLowerCase());
      })
    ) {
      continue;
    }
    try {
      await octokit.graphql(
        `mutation($id:ID!){
          resolveReviewThread(input:{threadId:$id}){thread{isResolved}}
        }`,
        { id: thread.id },
      );
      resolved++;
    } catch (err) {
      log(`warn: failed to resolve GitHub review thread ${thread.id}: ${(err as Error).message}`);
    }
  }
  return resolved;
}

/**
 * Post new findings as one PR review with inline comments.
 * Persistent findings (same id already on the PR) are skipped.
 */
export async function postReview(opts: PostReviewOptions): Promise<void> {
  const { octokit, pr, result, log = () => {} } = opts;

  const toPost = result.findingsToPost ?? result.findings;
  const existingIds = await listPostedFindingIds(octokit, pr);

  const comments = [];
  let skipped = 0;
  for (const f of toPost) {
    if (f.id && existingIds.has(f.id)) {
      skipped++;
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
  if (skipped) log(`Skipping ${skipped} comment(s) already posted (same finding id).`);

  const body = formatReviewBody(result, opts.failed, opts.headSha);

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
    log(`Inline review failed (${(err as Error).message}); posting summary-only review.`);
    const fallbackBody = [
      body,
      "",
      "### Findings (inline placement failed)",
      ...toPost.map(
        (f) =>
          `- **${f.severity}** \`${f.file}:${f.start_line}-${f.end_line}\` — ${f.title}${f.id ? ` (\`${f.id}\`)` : ""}\n\n  ${f.body.split("\n").join("\n  ")}`,
      ),
    ].join("\n");
    await octokit.pulls.createReview({
      ...pr,
      commit_id: opts.headSha,
      event: "COMMENT",
      body: fallbackBody,
    });
  }

  const resolvedIds = result.reconciliation?.resolved ?? [];
  if (resolvedIds.length > 0) {
    const resolved = await resolveThreadsForIds(octokit, pr, resolvedIds, log);
    if (resolved) log(`Resolved ${resolved} thread(s) for fixed findings.`);
  }
}
