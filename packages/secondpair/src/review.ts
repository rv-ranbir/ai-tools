import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { detectSignals, estimateTokens, getModel, loadIndex, selectContext, structuredCall, type ContextEntry, type Signal } from "repocairn";
import { isIgnored } from "./config.js";
import { parseDiff } from "./diff/parse.js";
import { withFindingId } from "./finding-id.js";
import {
  CRITIQUE_SYSTEM_PROMPT,
  DEDUP_SYSTEM_PROMPT,
  HIGH_LEVEL_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  buildCritiqueUserPrompt,
  buildDedupUserPrompt,
  buildReviewUserPrompt,
} from "./llm/prompt.js";
import { reviewOutputSchema, validateFindings, type ReviewOutput } from "./llm/schema.js";
import { reconcileFindings, type Reconciliation } from "./reconcile.js";
import { compileRedactPatterns, redactSecrets } from "./redact.js";
import { withRetry } from "./retry.js";
import { runSpecializedReview } from "./specialized-review.js";
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
  /**
   * Paths changed since the last reviewed commit. When set, only these
   * files are sent to the LLM — everything else in the diff is assumed
   * untouched since the last review and skipped entirely (see
   * `carryForwardFindings`). Undefined means a full review of every file.
   */
  changedFiles?: Set<string>;
  /**
   * Findings from files NOT in `changedFiles` (untouched since the last
   * review) — merged straight into the result as persistent, without any
   * LLM call, since nothing about them could have changed.
   */
  carryForwardFindings?: Finding[];
  log?: (msg: string) => void;
}

export interface RunReviewOutput extends ReviewResult {
  files: FileDiff[];
  usedContext: boolean;
  stats: RunStats;
  /** Files that import the changed files, ranked by import count — the "blast radius" of this PR. */
  blastRadius: ContextEntry[];
  /** True if the diff exceeded `huge_pr_token_threshold` and only a critical/high, split-recommending pass ran. */
  highLevelReview: boolean;
  /** Deterministic summary of the change, assembled from Phase A/B output before any LLM call. */
  reviewBrief: ReviewBrief;
}

export interface ReviewBrief {
  files: string[];
  /** Paths of files that import the changed files (blastRadius, path-only). */
  blastRadius: string[];
  signals: Signal[];
  totalTokens: number;
}

/** Sum of the same per-file token cost `chunkFiles` uses, across the whole diff. */
export function totalDiffTokens(files: FileDiff[]): number {
  return files.reduce((sum, f) => sum + estimateTokens(JSON.stringify(f.hunks)), 0);
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
      blastRadius: [],
      highLevelReview: false,
      reviewBrief: { files: [], blastRadius: [], signals: [], totalTokens: 0 },
    };
  }
  const filesToAnalyze = opts.changedFiles
    ? files.filter((f) => opts.changedFiles!.has(f.path))
    : files;
  if (opts.changedFiles) {
    log(
      `Reviewing ${filesToAnalyze.length} changed file(s); ${files.length - filesToAnalyze.length} unchanged since the last review are carried forward.`,
    );
  } else {
    log(`Reviewing ${files.length} changed file(s).`);
  }

  const highLevelReview =
    opts.config.huge_pr_token_threshold != null &&
    totalDiffTokens(filesToAnalyze) > opts.config.huge_pr_token_threshold;
  if (highLevelReview) {
    log(
      `Diff exceeds huge_pr_token_threshold (${opts.config.huge_pr_token_threshold} tokens) — running a critical/high-only, split-recommending review.`,
    );
  }

  let context = "";
  let usedContext = false;
  let blastRadius: ContextEntry[] = [];
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
      blastRadius = selection.entries.filter((e) => e.relation === "importer");
      log(`Injecting context from ${selection.entries.length} codemap entries.`);
    } else {
      log(
        "No repocairn index found (.repocairn/index.json) — reviewing diff-only. Run `repocairn init` (or `repocairn index`) and commit the index for whole-repo context.",
      );
    }
  }
  context = maybeRedact(context);

  const signals = opts.config.signal_detector ? await collectSignals(opts.cwd, files) : [];
  if (signals.length > 0) log(`Signal detector found ${signals.length} signal(s) in added lines.`);

  const reviewBrief: ReviewBrief = {
    files: files.map((f) => f.path),
    blastRadius: blastRadius.map((e) => e.path),
    signals,
    totalTokens: totalDiffTokens(files),
  };

  const chunks = chunkFiles(filesToAnalyze);
  if (chunks.length > 1) log(`Large diff — splitting into ${chunks.length} review calls.`);

  const runParallel = opts.config.parallel_agents && !highLevelReview;
  if (runParallel) log("Running security/correctness/quality lenses in parallel.");

  const outputs: ReviewOutput[] = [];
  const lensStats: Record<string, { calls: number; inputTokens: number; outputTokens: number }> = {};
  for (const chunk of chunks) {
    const chunkPaths = new Set(chunk.map((f) => f.path));
    const signalsText = renderSignals(signals.filter((s) => chunkPaths.has(s.file)));

    if (runParallel) {
      const specialized = await runSpecializedReview({
        files: chunk,
        context,
        signalsText,
        config: opts.config,
        changeDescription: opts.changeDescription,
        temperature,
      });
      outputs.push(...specialized.outputs);
      for (const [key, stat] of Object.entries(specialized.lensStats)) {
        const acc = (lensStats[key] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
        acc.calls += stat.calls;
        acc.inputTokens += stat.inputTokens;
        acc.outputTokens += stat.outputTokens;
        stats.llmCalls += stat.calls;
        stats.inputTokens += stat.inputTokens;
        stats.outputTokens += stat.outputTokens;
      }
      continue;
    }

    const user = buildReviewUserPrompt({
      files: chunk,
      context,
      config: opts.config,
      changeDescription: opts.changeDescription,
      signals: signalsText,
    });
    const output = await withRetry(() =>
      structuredCall({
        system: highLevelReview ? HIGH_LEVEL_SYSTEM_PROMPT : REVIEW_SYSTEM_PROMPT,
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
  if (Object.keys(lensStats).length > 0) stats.lensStats = lensStats;

  const merged: ReviewOutput = {
    summary: outputs.map((o) => o.summary).join(" "),
    findings: outputs.flatMap((o) => o.findings),
  };

  const validated = validateFindings(merged, filesToAnalyze, opts.config);
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
  if (opts.config.self_critique && identified.length > 0 && !highLevelReview) {
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

  // Carry-forward only applies to files we did not re-analyze. Findings on
  // changed files belong in previousFindings — if the LLM no longer reports
  // them they are resolved, not carried forward.
  const carryForwardRaw = opts.carryForwardFindings ?? [];
  const carryForward = carryForwardRaw.filter(
    (f) => !opts.changedFiles || !opts.changedFiles.has(f.file),
  );
  if (carryForwardRaw.length > carryForward.length) {
    log(
      `Dropped ${carryForwardRaw.length - carryForward.length} carry-forward finding(s) on re-analyzed file(s).`,
    );
  }
  const carryForwardIds = carryForward.map((f) => f.id).filter((id): id is string => !!id);

  const { active, toPost: toPostRaw, reconciliation: reconciliationRaw } = reconcileFindings(identified, {
    previousIds: opts.previousIds,
    previousFindings: opts.previousFindings,
    suppressedIds: opts.suppressedIds,
    retainedIds: carryForwardIds,
  });

  // Exact-id and soft-match reconciliation can both miss a reworded finding
  // (same issue, different title/body) — catch those with an LLM comparison
  // against everything already posted, so we don't post a second comment for
  // an issue someone edited around without fixing.
  let dedupMatched = new Set<string>();
  if (opts.config.semantic_dedup && reconciliationRaw.new.length > 0) {
    const newFindings = active.filter((f) => f.id && reconciliationRaw.new.includes(f.id));
    const newFiles = new Set(newFindings.map((f) => f.file));
    // DEDUP_SYSTEM_PROMPT only ever matches within the same file, so prior
    // findings from files the new candidates don't touch can't match —
    // sending them just burns tokens (and on a PR where the touched files
    // never had prior findings, this empties the pool and skips the call).
    const priorPool = [...(opts.previousFindings ?? []), ...(opts.carryForwardFindings ?? [])].filter((f) =>
      newFiles.has(f.file),
    );
    if (priorPool.length > 0 && newFindings.length > 0) {
      const dedupSchema = z.object({
        duplicates: z
          .array(z.object({ new_id: z.string(), prior_id: z.string() }))
          .describe("New finding ids that describe the same issue as a prior finding"),
      });
      const dedup = await withRetry(() =>
        structuredCall({
          system: DEDUP_SYSTEM_PROMPT,
          user: buildDedupUserPrompt({
            newFindings: newFindings.map((f) => ({
              id: f.id,
              file: f.file,
              start_line: f.start_line,
              title: f.title,
              body: f.body,
            })),
            priorFindings: priorPool.map((f) => ({ id: f.id, file: f.file, title: f.title })),
          }),
          schema: dedupSchema,
          schemaName: "dedup_output",
          temperature,
          onUsage,
        }),
      );
      stats.llmCalls += 1;
      dedupMatched = new Set(dedup.duplicates.map((d) => d.new_id));
      if (dedupMatched.size > 0) {
        log(`Semantic dedup: ${dedupMatched.size} "new" finding(s) already covered by an existing comment.`);
      }
    }
  }
  const reconciliation: Reconciliation =
    dedupMatched.size > 0
      ? {
          ...reconciliationRaw,
          new: reconciliationRaw.new.filter((id) => !dedupMatched.has(id)),
          persistent: [...reconciliationRaw.persistent, ...reconciliationRaw.new.filter((id) => dedupMatched.has(id))],
        }
      : reconciliationRaw;
  const toPost = toPostRaw.filter((f) => !(f.id && dedupMatched.has(f.id)));

  // Files untouched since the last review were never re-analyzed — their
  // prior findings carry forward as persistent without going through
  // reconciliation (nothing could have been "resolved" in code nobody edited).
  if (carryForward.length > 0) {
    log(`Carrying forward ${carryForward.length} finding(s) from unchanged file(s) (no re-analysis).`);
  }
  const finalActive = [...active, ...carryForward];
  const finalReconciliation: Reconciliation = {
    ...reconciliation,
    persistent: [...reconciliation.persistent, ...carryForwardIds],
  };

  log(
    `Reconciliation: ${finalReconciliation.new.length} new, ${finalReconciliation.persistent.length} persistent, ${finalReconciliation.resolved.length} resolved, ${finalReconciliation.suppressed.length} suppressed.`,
  );

  for (const f of finalActive) stats.findingsBySeverity[f.severity] += 1;
  stats.suppressed = reconciliation.suppressed.length;
  stats.persistent = finalReconciliation.persistent.length;

  const summary =
    filesToAnalyze.length === 0 && carryForward.length > 0
      ? `No changes since the last review. ${carryForward.length} previous finding(s) carried forward.`
      : validated.summary;

  return {
    findings: finalActive,
    summary,
    dropped: [...validated.dropped, ...capped, ...duplicates, ...droppedCritique],
    reconciliation: finalReconciliation,
    findingsToPost: toPost,
    files,
    usedContext,
    stats,
    blastRadius,
    highLevelReview,
    reviewBrief,
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

/** Run the deterministic signal detector on each changed file's current content. */
async function collectSignals(cwd: string, files: FileDiff[]): Promise<Signal[]> {
  const signals: Signal[] = [];
  for (const f of files) {
    if (f.status === "deleted" || f.changedLines.length === 0) continue;
    try {
      const content = await readFile(path.join(cwd, f.path), "utf8");
      signals.push(...detectSignals(f.path, content, f.changedLines));
    } catch {
      // file unreadable (e.g. sparse checkout) — skip, same as renderSnippets
    }
  }
  return signals;
}

function renderSignals(signals: Signal[]): string {
  return signals.map((s) => `- ${s.file}:${s.line} [${s.kind}] ${s.detail}`).join("\n");
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
