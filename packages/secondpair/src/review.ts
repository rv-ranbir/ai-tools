import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { estimateTokens, getModel, loadIndex, selectContext, structuredCall } from "repocairn";
import { isIgnored } from "./config.js";
import { parseDiff } from "./diff/parse.js";
import { withFindingId } from "./finding-id.js";
import {
  CRITIQUE_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  buildCritiqueUserPrompt,
  buildReviewUserPrompt,
} from "./llm/prompt.js";
import { reviewOutputSchema, validateFindings, type ReviewOutput } from "./llm/schema.js";
import { reconcileFindings, type Reconciliation } from "./reconcile.js";
import { compileRedactPatterns, redactSecrets } from "./redact.js";
import { SEVERITIES, severityRank, type FileDiff, type Finding, type ReviewConfig, type ReviewResult, type RunStats, type Severity } from "./types.js";

/** Cap on the prompt tokens spent on diff text per LLM call; larger diffs are chunked by file. */
const DIFF_TOKENS_PER_CALL = 60_000;

export interface RunReviewOptions {
  cwd: string;
  diffText: string;
  config: ReviewConfig;
  changeDescription: string;
  /** Disable codemap context injection. */
  useContext?: boolean;
  /** Fingerprints from a previous report or existing PR comments. */
  previousIds?: Iterable<string>;
  /** Prior findings for soft-match when titles were rephrased. */
  previousFindings?: import("./reconcile.js").PreviousFinding[];
  /** Ids listed in `.pr-review-suppressions.yml`. */
  suppressedIds?: Iterable<string>;
  log?: (msg: string) => void;
}

export interface RunReviewOutput extends ReviewResult {
  files: FileDiff[];
  usedContext: boolean;
  stats: RunStats;
}

/** Token cap per inlined source snippet (~4 chars/token). */
const SNIPPET_TOKENS_PER_FILE = 2000;

export async function runReview(opts: RunReviewOptions): Promise<RunReviewOutput> {
  const log = opts.log ?? (() => {});

  const stats: RunStats = {
    model: getModel(),
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    findingsBySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>,
    droppedValidation: 0,
    droppedCaps: 0,
    droppedDuplicates: 0,
    droppedCritique: 0,
    suppressed: 0,
    persistent: 0,
  };
  const onUsage = (u: { inputTokens: number; outputTokens: number }) => {
    stats.inputTokens += u.inputTokens;
    stats.outputTokens += u.outputTokens;
  };
  const temperature = opts.config.temperature ?? undefined;
  const extraRedactPatterns =
    opts.config.redact_secrets && opts.config.redact_patterns.length > 0
      ? compileRedactPatterns(opts.config.redact_patterns)
      : [];
  const maybeRedact = (text: string) =>
    opts.config.redact_secrets ? redactSecrets(text, extraRedactPatterns) : text;

  // Parse redacted text so raw secrets never enter prompts. PEM replacement may collapse lines.
  const allFiles = parseDiff(maybeRedact(opts.diffText));
  const files = allFiles.filter(
    (f) => !isIgnored(f.path, opts.config) && f.status !== "deleted" && f.changedLines.length > 0,
  );
  if (files.length === 0) {
    return {
      findings: [],
      summary: "No reviewable changes in the diff.",
      dropped: [],
      files: [],
      usedContext: false,
      reconciliation: emptyReconciliation(),
      findingsToPost: [],
      stats,
    };
  }
  log(`Reviewing ${files.length} changed file(s).`);

  let context = "";
  let usedContext = false;
  if (opts.useContext !== false) {
    const index = await loadIndex(opts.cwd);
    if (index) {
      const selection = selectContext(
        index,
        files.map((f) => f.path),
        opts.config.context_token_budget,
      );
      const snippets = await renderSnippets(opts.cwd, selection.entries, opts.config.context_snippets);
      context = [selection.rendered, snippets].filter(Boolean).join("\n\n");
      usedContext = selection.entries.length > 0;
      log(`Injecting context from ${selection.entries.length} codemap entries.`);
    } else {
      log(
        "No repocairn index found (.repocairn/index.json) — reviewing diff-only. Run `repocairn init` (or `repocairn index`) and commit the index for whole-repo context.",
      );
    }
  }
  context = maybeRedact(context);

  const chunks = chunkFiles(files);
  if (chunks.length > 1) log(`Large diff — splitting into ${chunks.length} review calls.`);

  const outputs: ReviewOutput[] = [];
  for (const chunk of chunks) {
    const user = buildReviewUserPrompt({
      files: chunk,
      context,
      config: opts.config,
      changeDescription: opts.changeDescription,
    });
    const output = await withRetry(() =>
      structuredCall({
        system: REVIEW_SYSTEM_PROMPT,
        user,
        schema: reviewOutputSchema,
        schemaName: "review_output",
        temperature,
        onUsage,
      }),
    );
    stats.llmCalls += 1;
    outputs.push(output);
  }

  const merged: ReviewOutput = {
    summary: outputs.map((o) => o.summary).join(" "),
    findings: outputs.flatMap((o) => o.findings),
  };

  const validated = validateFindings(merged, files, opts.config);
  stats.droppedValidation = validated.dropped.length;
  if (validated.dropped.length > 0) {
    log(
      `Dropped ${validated.dropped.length} finding(s) failing validation (outside diff, low confidence, or disabled category).`,
    );
  }

  const { kept, capped } = capFindings(validated.findings, opts.config.limits);
  stats.droppedCaps = capped.length;
  if (capped.length > 0) {
    log(`Capped ${capped.length} finding(s) (limits: ${opts.config.limits.max_findings_per_file}/file, ${opts.config.limits.max_total} total).`);
  }

  const { kept: deduped, duplicates } = dedupeById(kept.map((f) => withFindingId(f)));
  stats.droppedDuplicates = duplicates.length;
  if (duplicates.length > 0) {
    log(`Dropped ${duplicates.length} duplicate finding(s) (same file/category/title reported more than once).`);
  }
  let identified: Finding[] = deduped;

  let droppedCritique: Finding[] = [];
  if (opts.config.self_critique && identified.length > 0) {
    const keepSchema = z.object({
      keep_ids: z.array(z.string()).describe("Ids of the findings to keep"),
    });
    const critique = await withRetry(() =>
      structuredCall({
        system: CRITIQUE_SYSTEM_PROMPT,
        user: buildCritiqueUserPrompt({ findings: identified, changeDescription: opts.changeDescription }),
        schema: keepSchema,
        schemaName: "critique_output",
        temperature,
        onUsage,
      }),
    );
    stats.llmCalls += 1;
    const keep = new Set(critique.keep_ids);
    const surviving = identified.filter((f) => keep.has(f.id!));
    // A keep-list that empties the review is a misfire, not a judgment — keep everything.
    if (surviving.length > 0 || identified.length === 0) {
      droppedCritique = identified.filter((f) => !keep.has(f.id!));
      identified = surviving;
    }
    stats.droppedCritique = droppedCritique.length;
    if (droppedCritique.length > 0) {
      log(`Self-critique dropped ${droppedCritique.length} finding(s) it would not defend.`);
    }
  }

  const { active, toPost, reconciliation } = reconcileFindings(identified, {
    previousIds: opts.previousIds,
    previousFindings: opts.previousFindings,
    suppressedIds: opts.suppressedIds,
  });

  log(
    `Reconciliation: ${reconciliation.new.length} new, ${reconciliation.persistent.length} persistent, ${reconciliation.resolved.length} resolved, ${reconciliation.suppressed.length} suppressed.`,
  );

  for (const f of active) stats.findingsBySeverity[f.severity] += 1;
  stats.suppressed = reconciliation.suppressed.length;
  stats.persistent = reconciliation.persistent.length;

  return {
    findings: active,
    summary: validated.summary,
    dropped: [...validated.dropped, ...capped, ...duplicates, ...droppedCritique],
    reconciliation,
    findingsToPost: toPost,
    files,
    usedContext,
    stats,
  };
}

/**
 * Collapse findings that share a fingerprint id — the same underlying issue
 * reported more than once in a single LLM response (or across chunked calls
 * for a file split isn't possible, but the model itself repeating a finding
 * for the same file/category/title is common). Keeps the higher-confidence
 * copy; first-seen position is preserved so downstream ordering is stable.
 */
export function dedupeById(findings: Finding[]): { kept: Finding[]; duplicates: Finding[] } {
  const byId = new Map<string, Finding>();
  const duplicates: Finding[] = [];
  for (const f of findings) {
    const id = f.id!;
    const prior = byId.get(id);
    if (!prior) {
      byId.set(id, f);
    } else if (f.confidence > prior.confidence) {
      byId.set(id, f);
      duplicates.push(prior);
    } else {
      duplicates.push(f);
    }
  }
  return { kept: [...byId.values()], duplicates };
}

/**
 * Enforce per-file and total finding caps, dropping lowest-confidence first
 * (severity breaks ties). Kept findings stay in validation order.
 */
export function capFindings(
  findings: Finding[],
  limits: ReviewConfig["limits"],
): { kept: Finding[]; capped: Finding[] } {
  const value = (f: Finding) => f.confidence - severityRank(f.severity) / 100;
  const capped = new Set<Finding>();

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }
  for (const group of byFile.values()) {
    if (group.length <= limits.max_findings_per_file) continue;
    [...group]
      .sort((a, b) => value(a) - value(b))
      .slice(0, group.length - limits.max_findings_per_file)
      .forEach((f) => capped.add(f));
  }

  let kept = findings.filter((f) => !capped.has(f));
  if (kept.length > limits.max_total) {
    [...kept]
      .sort((a, b) => value(a) - value(b))
      .slice(0, kept.length - limits.max_total)
      .forEach((f) => capped.add(f));
    kept = findings.filter((f) => !capped.has(f));
  }

  return { kept, capped: findings.filter((f) => capped.has(f)) };
}

/** Inline exact source of the top-N related (non-changed) context files, truncated per file. */
async function renderSnippets(
  cwd: string,
  entries: { path: string; relation: string }[],
  count: number,
): Promise<string> {
  if (count <= 0) return "";
  const related = entries.filter((e) => e.relation !== "changed").slice(0, count);
  const parts: string[] = [];
  for (const e of related) {
    try {
      const src = await readFile(path.join(cwd, e.path), "utf8");
      const maxChars = SNIPPET_TOKENS_PER_FILE * 4;
      const body = src.length > maxChars ? `${src.slice(0, maxChars)}\n… (truncated)` : src;
      parts.push(`## ${e.path} (full source, ${e.relation} of the change)\n\`\`\`\n${body}\n\`\`\``);
    } catch {
      // file missing from the working tree (e.g. sparse checkout) — skip
    }
  }
  return parts.join("\n\n");
}

function emptyReconciliation(): Reconciliation {
  return { new: [], persistent: [], resolved: [], suppressed: [] };
}

function chunkFiles(files: FileDiff[]): FileDiff[][] {
  const chunks: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let tokens = 0;
  for (const f of files) {
    const cost = estimateTokens(JSON.stringify(f.hunks));
    if (current.length > 0 && tokens + cost > DIFF_TOKENS_PER_CALL) {
      chunks.push(current);
      current = [];
      tokens = 0;
    }
    current.push(f);
    tokens += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  }
  throw last;
}
