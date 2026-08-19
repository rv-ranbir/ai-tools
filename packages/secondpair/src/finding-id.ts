import { createHash } from "node:crypto";
import type { Finding } from "./types.js";

export const FINDING_ID_MARKER_PREFIX = "[secondpair-id]: # (pr-review-id:";
export const FINDING_ID_RE = /\[secondpair-id\]:\s*#\s*\(pr-review-id:\s*([a-f0-9]+)\)/i;

/** Words that add churn without distinguishing the finding. */
const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "is", "are", "be",
  "this", "that", "with", "from", "by", "at", "as", "it", "its", "into", "via",
  "when", "which", "who", "whom", "what", "how", "than", "then", "also", "just",
  "not", "no", "can", "could", "should", "would", "may", "might", "will", "does",
  "do", "did", "has", "have", "had", "been", "being", "was", "were", "using", "use",
  "used", "new", "old", "same", "such", "so", "too", "very", "more", "most",
]);

/** Normalize title so minor wording churn still often matches. */
export function normalizeTitle(title: string): string {
  return titleTokens(title).join(" ");
}

/** Significant tokens from a title (lowercase, no stopwords, len ≥ 3). */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Stable fingerprint: file + category + sorted significant title tokens.
 * Line numbers are excluded (they drift). Token set ignores filler words so
 * "Off-by-one loop reads past end" ≈ "Off-by-one loop includes xs length".
 */
export function fingerprintFinding(
  f: Pick<Finding, "file" | "category" | "title">,
): string {
  const tokens = [...new Set(titleTokens(f.title))].sort();
  const key = `${f.file}|${f.category}|${tokens.join(" ")}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

export function withFindingId<T extends Finding>(f: T): T & { id: string } {
  return { ...f, id: f.id ?? fingerprintFinding(f) };
}

export function embedFindingId(body: string, id: string): string {
  if (FINDING_ID_RE.test(body)) {
    return body.replace(FINDING_ID_RE, `${FINDING_ID_MARKER_PREFIX} ${id})`);
  }
  return `${body.trimEnd()}\n\n${FINDING_ID_MARKER_PREFIX} ${id})\n`;
}

export function parseFindingId(body: string): string | null {
  return FINDING_ID_RE.exec(body)?.[1] ?? null;
}

export function collectIdsFromBodies(bodies: string[]): Set<string> {
  const ids = new Set<string>();
  for (const b of bodies) {
    const id = parseFindingId(b);
    if (id) ids.add(id);
  }
  return ids;
}

/** Jaccard similarity of significant title tokens (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** True when line ranges overlap or sit within `slack` lines of each other. */
export function linesNear(
  a: Pick<Finding, "start_line" | "end_line">,
  b: Pick<Finding, "start_line" | "end_line">,
  slack = 3,
): boolean {
  const a0 = a.start_line - slack;
  const a1 = a.end_line + slack;
  return a0 <= b.end_line && b.start_line <= a1;
}

/**
 * Soft match for re-runs where the model rephrases the title.
 * Same file + category + nearby lines + enough title-token overlap.
 */
export function findingsSoftMatch(
  a: Pick<Finding, "file" | "category" | "title" | "start_line" | "end_line">,
  b: Pick<Finding, "file" | "category" | "title" | "start_line" | "end_line">,
  minTitleSimilarity = 0.3,
): boolean {
  if (a.file !== b.file || a.category !== b.category) return false;
  if (!linesNear(a, b)) return false;
  const ta = new Set(titleTokens(a.title));
  const tb = new Set(titleTokens(b.title));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  if (inter >= 2) return true;
  return titleSimilarity(a.title, b.title) >= minTitleSimilarity;
}
