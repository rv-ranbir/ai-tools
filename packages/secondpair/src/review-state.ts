import type { Finding } from "./types.js";

/**
 * Full review state (head sha + every active finding) embedded in the
 * summary comment, so the next CI run — a fresh checkout with no local
 * report file — can recover exactly what was found last time without
 * scraping/re-parsing individual inline comments. Same encoding on every
 * platform: only "fetch the latest agent summary comment" differs.
 */
export interface ReviewState {
  headSha: string;
  findings: Finding[];
}

const STATE_MARKER_PREFIX = "[secondpair-state]: # (";
const STATE_RE = /\[secondpair-state\]:\s*#\s*\(([A-Za-z0-9+/=]+)\)/;

/** Append (or replace) the hidden state blob at the end of a summary comment body. */
export function embedReviewState(body: string, state: ReviewState): string {
  const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64");
  const stripped = body.replace(STATE_RE, "").trimEnd();
  return `${stripped}\n\n${STATE_MARKER_PREFIX}${encoded})`;
}

/** Recover the previously embedded state, or null if absent/corrupt. */
export function parseReviewState(body: string): ReviewState | null {
  const m = STATE_RE.exec(body);
  if (!m) return null;
  try {
    const parsed = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
    if (typeof parsed?.headSha === "string" && Array.isArray(parsed.findings)) return parsed;
    return null;
  } catch {
    return null;
  }
}
