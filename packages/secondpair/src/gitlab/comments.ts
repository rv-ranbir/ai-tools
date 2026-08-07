import { formatBbCommentBody, formatBbSummaryBody } from "../bitbucket/comments.js";
import { collectIdsFromBodies, parseFindingId } from "../finding-id.js";
import { AGENT_MARKER, SEVERITY_EMOJI } from "../github/comments.js";
import { collectWontFixIds } from "../suppress-signals.js";
import type { Finding, ReviewResult } from "../types.js";
import { resolveGlToken, type GlRef } from "./auth.js";

export interface GlDiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

function glApi(ref: GlRef): string {
  return `${ref.serverUrl}/api/v4/projects/${ref.projectId}/merge_requests/${ref.mrIid}`;
}

async function glFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "private-token": resolveGlToken(),
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitLab API ${init.method ?? "GET"} ${url} failed (${res.status}): ${text.slice(0, 400)}`,
    );
  }
  return res;
}

/** Fetch MR changes and reconstruct a unified diff the parser understands. */
export async function getGlMrDiff(
  ref: GlRef,
): Promise<{ diffText: string; diffRefs: GlDiffRefs }> {
  const res = await glFetch(`${glApi(ref)}/changes`);
  const data = (await res.json()) as {
    diff_refs?: GlDiffRefs;
    changes?: {
      old_path: string;
      new_path: string;
      new_file?: boolean;
      deleted_file?: boolean;
      diff: string;
    }[];
  };
  if (!data.diff_refs) throw new Error("GitLab MR has no diff_refs (empty or unmergeable MR?).");
  const parts = (data.changes ?? []).map((c) => {
    const oldFile = c.new_file ? "/dev/null" : `a/${c.old_path}`;
    const newFile = c.deleted_file ? "/dev/null" : `b/${c.new_path}`;
    return `diff --git a/${c.old_path} b/${c.new_path}\n--- ${oldFile}\n+++ ${newFile}\n${c.diff}`;
  });
  return { diffText: parts.join(""), diffRefs: data.diff_refs };
}

interface GlNote {
  id?: number;
  body?: string;
  type?: string | null;
  parent_id?: number;
  reply_id?: number;
  discussion_id?: string;
}

export async function listGlNotes(ref: GlRef): Promise<GlNote[]> {
  const notes: GlNote[] = [];
  let page = 1;
  for (;;) {
    const res = await glFetch(`${glApi(ref)}/notes?per_page=100&page=${page}`);
    const batch = (await res.json()) as GlNote[];
    notes.push(...batch);
    const next = res.headers.get("x-next-page");
    if (!next) break;
    page = parseInt(next, 10);
  }
  return notes;
}

export async function listGlFindingIds(ref: GlRef): Promise<Set<string>> {
  const notes = await listGlNotes(ref);
  return collectIdsFromBodies(
    notes.filter((n) => n.body?.includes(AGENT_MARKER)).map((n) => n.body ?? ""),
  );
}

export async function listGlWontFixFindingIds(ref: GlRef): Promise<Set<string>> {
  const notes = await listGlNotes(ref);
  const byId = new Map(notes.flatMap((note) => (note.id == null ? [] : [[note.id, note] as const])));
  const discussionAgentIds = new Map<string, string>();
  for (const note of notes) {
    const body = note.body ?? "";
    const id = body.includes(AGENT_MARKER) ? parseFindingId(body) : null;
    if (note.discussion_id && id) discussionAgentIds.set(note.discussion_id, id);
  }
  return collectWontFixIds(
    notes.map((note) => {
      let parent = byId.get(note.parent_id ?? note.reply_id ?? -1);
      while (parent) {
        const body = parent.body ?? "";
        if (body.includes(AGENT_MARKER)) {
          return { body: note.body ?? "", parentAgentId: parseFindingId(body) };
        }
        parent = byId.get(parent.parent_id ?? parent.reply_id ?? -1);
      }
      const body = note.body ?? "";
      return {
        body,
        isAgent: body.includes(AGENT_MARKER),
        parentAgentId: note.discussion_id
          ? discussionAgentIds.get(note.discussion_id) ?? null
          : null,
      };
    }),
  );
}

interface GlDiscussion {
  id: string;
  notes: {
    body?: string;
    resolvable?: boolean;
    resolved?: boolean;
  }[];
}

/** Resolve unresolved MR discussions whose notes contain one of the finding ids. */
export async function resolveGlDiscussionsForIds(
  ref: GlRef,
  ids: Iterable<string>,
  log: (msg: string) => void = () => {},
): Promise<number> {
  const wanted = new Set(Array.from(ids, (id) => id.toLowerCase()));
  if (wanted.size === 0) return 0;

  const discussions: GlDiscussion[] = [];
  try {
    let page = 1;
    for (;;) {
      const res = await glFetch(`${glApi(ref)}/discussions?per_page=100&page=${page}`);
      discussions.push(...((await res.json()) as GlDiscussion[]));
      const next = res.headers.get("x-next-page");
      if (!next) break;
      page = parseInt(next, 10);
    }
  } catch (err) {
    log(`warn: failed to list GitLab discussions: ${(err as Error).message}`);
    return 0;
  }

  let resolved = 0;
  for (const discussion of discussions) {
    const matches = discussion.notes.some((note) => {
      const id = parseFindingId(note.body ?? "");
      return id != null && wanted.has(id.toLowerCase());
    });
    const unresolved = discussion.notes.some(
      (note) => note.resolvable !== false && note.resolved !== true,
    );
    if (!matches || !unresolved) continue;

    try {
      await glFetch(`${glApi(ref)}/discussions/${discussion.id}`, {
        method: "PUT",
        body: JSON.stringify({ resolved: true }),
      });
      resolved++;
    } catch (err) {
      log(`warn: failed to resolve GitLab discussion ${discussion.id}: ${(err as Error).message}`);
    }
  }
  return resolved;
}

export interface PostGlReviewOptions {
  ref: GlRef;
  diffRefs: GlDiffRefs;
  result: ReviewResult;
  failed: boolean;
  log?: (msg: string) => void;
}

/**
 * Post findings to a GitLab MR: one summary note plus one positioned discussion
 * per *new* finding. Persistent findings (same pr-review-id) are skipped.
 */
export async function postGlReview(opts: PostGlReviewOptions): Promise<void> {
  const { ref, diffRefs, result, log = () => {} } = opts;

  const notes = await listGlNotes(ref);
  const mine = notes.filter((n) => n.body?.includes(AGENT_MARKER));
  const existingIds = collectIdsFromBodies(mine.map((n) => n.body ?? ""));
  const alreadySummarized = mine.some((n) => n.type == null);

  if (!alreadySummarized || result.findings.length === 0) {
    await glFetch(`${glApi(ref)}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: formatBbSummaryBody(result, opts.failed) }),
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
      await glFetch(`${glApi(ref)}/discussions`, {
        method: "POST",
        body: JSON.stringify({
          body: formatBbCommentBody(f),
          position: {
            position_type: "text",
            base_sha: diffRefs.base_sha,
            start_sha: diffRefs.start_sha,
            head_sha: diffRefs.head_sha,
            new_path: f.file,
            new_line: f.end_line,
          },
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
    await glFetch(`${glApi(ref)}/notes`, { method: "POST", body: JSON.stringify({ body }) });
  }

  log(
    `GitLab: posted ${posted} inline discussion(s)` +
      (skipped ? `, skipped ${skipped} duplicate(s)` : "") +
      (failedInline.length ? `, ${failedInline.length} moved to a summary note` : "") +
      ".",
  );

  const resolvedIds = result.reconciliation?.resolved ?? [];
  if (resolvedIds.length > 0) {
    const resolved = await resolveGlDiscussionsForIds(ref, resolvedIds, log);
    if (resolved) log(`GitLab: resolved ${resolved} discussion(s) for fixed findings.`);
  }
}
