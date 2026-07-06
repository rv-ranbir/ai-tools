import { estimateTokens, loadIndex, selectContext, structuredCall } from "repomind";
import { isIgnored } from "./config.js";
import { parseDiff } from "./diff/parse.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewUserPrompt } from "./llm/prompt.js";
import { reviewOutputSchema, validateFindings, type ReviewOutput } from "./llm/schema.js";
import type { FileDiff, ReviewConfig, ReviewResult } from "./types.js";

/** Cap on the prompt tokens spent on diff text per LLM call; larger diffs are chunked by file. */
const DIFF_TOKENS_PER_CALL = 60_000;

export interface RunReviewOptions {
  cwd: string;
  diffText: string;
  config: ReviewConfig;
  changeDescription: string;
  /** Disable codemap context injection. */
  useContext?: boolean;
  log?: (msg: string) => void;
}

export interface RunReviewOutput extends ReviewResult {
  files: FileDiff[];
  usedContext: boolean;
}

export async function runReview(opts: RunReviewOptions): Promise<RunReviewOutput> {
  const log = opts.log ?? (() => {});

  const allFiles = parseDiff(opts.diffText);
  const files = allFiles.filter(
    (f) => !isIgnored(f.path, opts.config) && f.status !== "deleted" && f.changedLines.length > 0,
  );
  if (files.length === 0) {
    return { findings: [], summary: "No reviewable changes in the diff.", dropped: [], files: [], usedContext: false };
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
      context = selection.rendered;
      usedContext = selection.entries.length > 0;
      log(`Injecting context from ${selection.entries.length} codemap entries.`);
    } else {
      log("No repomind index found (.repomind/index.json) — reviewing diff-only. Run `pr-review index` to enable repo context.");
    }
  }

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
      }),
    );
    outputs.push(output);
  }

  const merged: ReviewOutput = {
    summary: outputs.map((o) => o.summary).join(" "),
    findings: outputs.flatMap((o) => o.findings),
  };

  const result = validateFindings(merged, files, opts.config);
  if (result.dropped.length > 0) {
    log(`Dropped ${result.dropped.length} finding(s) failing validation (outside diff, low confidence, or disabled category).`);
  }
  return { ...result, files, usedContext };
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

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // One retry for transient schema/parse failures; SDK already retries 429/5xx.
    if (err instanceof Error && /schema/i.test(err.message)) {
      return await fn();
    }
    throw err;
  }
}
