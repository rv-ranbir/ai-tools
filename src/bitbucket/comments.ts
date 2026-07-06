import type { Finding, ReviewResult, Severity } from "../types.js";
import { AGENT_MARKER, SEVERITY_EMOJI } from "../github/comments.js";

const API = "https://api.bitbucket.org/2.0";

export interface BbRef {
  workspace: string;
  repoSlug: string;
  prId: number;
}

/**
 * Resolve Bitbucket Cloud auth from the environment:
 *   BITBUCKET_TOKEN / BITBUCKET_ACCESS_TOKEN            -> Bearer (repository access token)
 *   BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD         -> Basic (app password)
 */
export function resolveBbAuthHeader(): string {
  const env = process.env;
  const token = env.BITBUCKET_TOKEN || env.BITBUCKET_ACCESS_TOKEN;
  if (token) return `Bearer ${token}`;
  if (env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD) {
    const basic = Buffer.from(`${env.BITBUCKET_USERNAME}:${env.BITBUCKET_APP_PASSWORD}`).toString(
      "base64",
    );
    return `Basic ${basic}`;
  }
  throw new Error(
    "Bitbucket auth required: set BITBUCKET_TOKEN (repository access token with pullrequest:write) " +
      "or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD.",
  );
}

/** Resolve workspace/repo/PR id from flags or Bitbucket Pipelines env vars. */
export function resolveBbRef(repoSlug: string | undefined, pr: number | undefined): BbRef {
  const env = process.env;
  let workspace: string | undefined;
  let slug: string | undefined;
  if (repoSlug) {
    [workspace, slug] = repoSlug.split("/");
  } else {
    workspace = env.BITBUCKET_WORKSPACE;
    slug = env.BITBUCKET_REPO_SLUG;
  }
  const prId = pr ?? (env.BITBUCKET_PR_ID ? parseInt(env.BITBUCKET_PR_ID, 10) : undefined);
  if (!workspace || !slug || prId == null || Number.isNaN(prId)) {
    throw new Error(
      "Bitbucket PR not identified. Pass --repo workspace/repo_slug and --pr <id>, " +
        "or run inside Bitbucket Pipelines (BITBUCKET_WORKSPACE / BITBUCKET_REPO_SLUG / BITBUCKET_PR_ID).",
    );
  }
  return { workspace, repoSlug: slug, prId };
}

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
    throw new Error(`Bitbucket API ${init.method ?? "GET"} ${url} failed (${res.status}): ${text.slice(0, 400)}`);
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
  content?: { raw?: string };
  inline?: { path?: string; to?: number };
}

async function listBbComments(ref: BbRef): Promise<BbComment[]> {
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
  return parts.join("\n");
}

export function formatBbSummaryBody(result: ReviewResult, failed: boolean): string {
  const counts: Partial<Record<Severity, number>> = {};
  for (const f of result.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const countLine =
    result.findings.length === 0
      ? "No findings."
      : Object.entries(counts)
          .map(([sev, n]) => `${SEVERITY_EMOJI[sev as Severity]} ${n} ${sev}`)
          .join(" · ");
  return [
    "## PR Review Agent",
    "",
    result.summary.trim(),
    "",
    countLine,
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
 * comment per finding, anchored to the finding's last line. Comments already
 * posted by a previous run (same path/line/title) are skipped; inline anchors
 * the API rejects fall back into a follow-up summary comment.
 */
export async function postBbReview(opts: PostBbReviewOptions): Promise<void> {
  const { ref, result, log = () => {} } = opts;
  const commentsUrl = `${API}/repositories/${ref.workspace}/${ref.repoSlug}/pullrequests/${ref.prId}/comments`;

  const existing = await listBbComments(ref);
  const mine = existing.filter((c) => c.content?.raw?.includes(AGENT_MARKER));
  const existingKeys = new Set(
    mine
      .filter((c) => c.inline?.path != null)
      .map((c) => `${c.inline!.path}:${c.inline!.to}:${extractTitle(c.content?.raw ?? "")}`),
  );
  const alreadySummarized = mine.some((c) => c.inline == null);

  if (!alreadySummarized || result.findings.length === 0) {
    await bbFetch(commentsUrl, {
      method: "POST",
      body: JSON.stringify({ content: { raw: formatBbSummaryBody(result, opts.failed) } }),
    });
  }

  let posted = 0;
  let skipped = 0;
  const failedInline: Finding[] = [];
  for (const f of result.findings) {
    if (existingKeys.has(`${f.file}:${f.end_line}:${f.title}`)) {
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
}

function extractTitle(raw: string): string {
  const m = /\*\*(.+?)\*\*/g;
  m.exec(raw); // first bold run is the severity label
  return m.exec(raw)?.[1] ?? "";
}
