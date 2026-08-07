import { collectIdsFromBodies, embedFindingId, parseFindingId } from "../finding-id.js";
import { AGENT_MARKER, SEVERITY_EMOJI } from "../github/comments.js";
import { collectWontFixIds } from "../suppress-signals.js";
import type { Finding, ReviewResult, Severity } from "../types.js";
import { resolveBbAuthHeader, type BbRef } from "./auth.js";

const API = "https://api.bitbucket.org/2.0";

async function bbFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: resolveBbAuthHeader(),
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Bitbucket API ${init.method ?? "GET"} ${url} failed (${res.status}): ${text.slice(0, 400)}`,
    );
  }
  return res;
}

/** Fetch the unified diff of a Bitbucket Cloud pull request. */
export async function getBbPrDiff(ref: BbRef): Promise<string> {
  const res = await bbFetch(
    `${API}/repositories/${ref.workspace}/${ref.repoSlug}/pullrequests/${ref.prId}/diff`,
    { headers: { accept: "text/plain" } },
  );
  return res.text();
}

interface BbComment {
  id?: number;
  content?: { raw?: string };
  inline?: { path?: string; to?: number };
  parent?: { id?: number };
}

export async function listBbComments(ref: BbRef): Promise<BbComment[]> {
  const comments: BbComment[] = [];
  let url: string | null =
    `${API}/repositories/${ref.workspace}/${ref.repoSlug}/pullrequests/${ref.prId}/comments?pagelen=100`;
  while (url) {
    const res = await bbFetch(url);
    const page = (await res.json()) as { values?: BbComment[]; next?: string };
    comments.push(...(page.values ?? []));
    url = page.next ?? null;
  }
  return comments;
}

export async function listBbFindingIds(ref: BbRef): Promise<Set<string>> {
  const existing = await listBbComments(ref);
  return collectIdsFromBodies(
    existing.filter((c) => c.content?.raw?.includes(AGENT_MARKER)).map((c) => c.content?.raw ?? ""),
  );
}

export async function listBbWontFixFindingIds(ref: BbRef): Promise<Set<string>> {
  const comments = await listBbComments(ref);
  const byId = new Map(
    comments.flatMap((comment) => (comment.id == null ? [] : [[comment.id, comment] as const])),
  );
  return collectWontFixIds(
    comments.map((comment) => {
      let parent = comment.parent?.id == null ? undefined : byId.get(comment.parent.id);
      while (parent) {
        const body = parent.content?.raw ?? "";
        if (body.includes(AGENT_MARKER)) {
          return { body: comment.content?.raw ?? "", parentAgentId: parseFindingId(body) };
        }
        parent = parent.parent?.id == null ? undefined : byId.get(parent.parent.id);
      }
      const body = comment.content?.raw ?? "";
      return { body, isAgent: body.includes(AGENT_MARKER), parentAgentId: null };
    }),
  );
}

/** Bitbucket Cloud exposes no API for resolving pull-request comment threads. */
export async function resolveBbCommentsForIds(
  _ref: BbRef,
  _ids: Iterable<string>,
  log: (msg: string) => void = () => {},
): Promise<number> {
  log("Bitbucket: soft-resolve not supported; skipping");
  return 0;
}

/** Bitbucket markdown has no GitHub suggestion blocks — render fixes as code fences. */
export function formatBbCommentBody(f: Finding): string {
  const parts = [
    `${SEVERITY_EMOJI[f.severity]} **${f.severity.toUpperCase()}** · \`${f.category}\` · confidence ${Math.round(f.confidence * 100)}%`,
    "",
    `**${f.title}**`,
    "",
    f.body.trim(),
  ];
  if (f.suggestion) {
    parts.push("", "Suggested fix:", "```", f.suggestion.replace(/\n$/, ""), "```");
  }
  parts.push("", AGENT_MARKER);
  let body = parts.join("\n");
  if (f.id) body = embedFindingId(body, f.id);
  return body;
}

export function formatBbSummaryBody(
  result: ReviewResult & { highLevelReview?: boolean },
  failed: boolean,
): string {
  const counts: Partial<Record<Severity, number>> = {};
  for (const f of result.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
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
  return [
    "## PR Review Agent",
    "",
    result.summary.trim(),
    "",
    countLine,
    highLevelLine,
    reconLine,
    failed ? "\n❌ **Check failed**: findings at or above the configured severity threshold." : "",
    AGENT_MARKER,
  ].join("\n");
}

export interface PostBbReviewOptions {
  ref: BbRef;
  result: ReviewResult;
  failed: boolean;
  log?: (msg: string) => void;
}

/**
 * Post findings to a Bitbucket Cloud PR: one summary comment plus one inline
 * comment per *new* finding. Persistent findings (same pr-review-id) are skipped.
 */
export async function postBbReview(opts: PostBbReviewOptions): Promise<void> {
  const { ref, result, log = () => {} } = opts;
  const commentsUrl = `${API}/repositories/${ref.workspace}/${ref.repoSlug}/pullrequests/${ref.prId}/comments`;

  const existing = await listBbComments(ref);
  const mine = existing.filter((c) => c.content?.raw?.includes(AGENT_MARKER));
  const existingIds = collectIdsFromBodies(mine.map((c) => c.content?.raw ?? ""));
  const alreadySummarized = mine.some((c) => c.inline == null);

  if (!alreadySummarized || result.findings.length === 0) {
    await bbFetch(commentsUrl, {
      method: "POST",
      body: JSON.stringify({ content: { raw: formatBbSummaryBody(result, opts.failed) } }),
    });
  }

  const toPost = result.findingsToPost ?? result.findings;
  let posted = 0;
  let skipped = 0;
  const failedInline: Finding[] = [];
  for (const f of toPost) {
    if (f.id && existingIds.has(f.id)) {
      skipped++;
      continue;
    }
    try {
      await bbFetch(commentsUrl, {
        method: "POST",
        body: JSON.stringify({
          content: { raw: formatBbCommentBody(f) },
          inline: { path: f.file, to: f.end_line },
        }),
      });
      posted++;
    } catch {
      failedInline.push(f);
    }
  }

  if (failedInline.length > 0) {
    const body = [
      "### Findings that could not be placed inline",
      ...failedInline.map(
        (f) =>
          `- ${SEVERITY_EMOJI[f.severity]} **${f.severity}** \`${f.file}:${f.start_line}-${f.end_line}\` — ${f.title}\n\n  ${f.body.split("\n").join("\n  ")}`,
      ),
      "",
      AGENT_MARKER,
    ].join("\n");
    await bbFetch(commentsUrl, { method: "POST", body: JSON.stringify({ content: { raw: body } }) });
  }

  log(
    `Bitbucket: posted ${posted} inline comment(s)` +
      (skipped ? `, skipped ${skipped} duplicate(s)` : "") +
      (failedInline.length ? `, ${failedInline.length} moved to a summary comment` : "") +
      ".",
  );

  const resolvedIds = result.reconciliation?.resolved ?? [];
  if (resolvedIds.length > 0) {
    await resolveBbCommentsForIds(ref, resolvedIds, log);
  }
}
