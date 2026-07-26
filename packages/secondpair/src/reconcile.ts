import { findingsSoftMatch } from "./finding-id.js";
import type { Finding, Reconciliation } from "./types.js";

export type { Reconciliation };

export interface ReconcileResult {
  /** Findings that still count for display + CI gate (new + persistent). */
  active: Finding[];
  /** Findings that should be posted as new PR comments. */
  toPost: Finding[];
  reconciliation: Reconciliation;
}

export type PreviousFinding = Pick<
  Finding,
  "id" | "file" | "category" | "title" | "start_line" | "end_line"
>;

/**
 * Classify findings against previous/known ids and suppressions.
 * Soft-matches previous report findings when titles were rephrased, and
 * reuses the prior id so PR comment dedupe stays stable.
 */
export function reconcileFindings(
  findings: Finding[],
  opts: {
    previousIds?: Iterable<string>;
    previousFindings?: PreviousFinding[];
    suppressedIds?: Iterable<string>;
  } = {},
): ReconcileResult {
  const previous = new Set([...(opts.previousIds ?? [])].map((id) => id.toLowerCase()));
  for (const pf of opts.previousFindings ?? []) {
    if (pf.id) previous.add(pf.id.toLowerCase());
  }
  const suppressed = new Set([...(opts.suppressedIds ?? [])].map((id) => id.toLowerCase()));
  const previousFindings = [...(opts.previousFindings ?? [])].filter((p) => p.id);

  const reconciliation: Reconciliation = {
    new: [],
    persistent: [],
    resolved: [],
    suppressed: [],
  };

  const active: Finding[] = [];
  const toPost: Finding[] = [];
  const currentIds = new Set<string>();
  const claimedPrevious = new Set<string>();

  for (const raw of findings) {
    let f = raw;
    let id = (f.id ?? "").toLowerCase();
    if (!id) continue;

    // Exact id hit, or soft-match a prior finding and adopt its id.
    let matchedPrevious = previous.has(id);
    if (!matchedPrevious) {
      const soft = previousFindings.find(
        (p) =>
          p.id &&
          !claimedPrevious.has(p.id.toLowerCase()) &&
          !suppressed.has(p.id.toLowerCase()) &&
          findingsSoftMatch(f, p as Finding),
      );
      if (soft?.id) {
        const priorId = soft.id.toLowerCase();
        f = { ...f, id: priorId };
        id = priorId;
        matchedPrevious = true;
        claimedPrevious.add(priorId);
      }
    } else {
      claimedPrevious.add(id);
    }

    currentIds.add(id);

    if (suppressed.has(id)) {
      reconciliation.suppressed.push(id);
      continue;
    }

    if (matchedPrevious) {
      reconciliation.persistent.push(id);
      active.push(f);
    } else {
      reconciliation.new.push(id);
      active.push(f);
      toPost.push(f);
    }
  }

  for (const id of previous) {
    if (!currentIds.has(id) && !suppressed.has(id)) {
      reconciliation.resolved.push(id);
    }
  }

  return { active, toPost, reconciliation };
}
