import { loadConfig } from "../config.js";
import type { CodemapIndex } from "../types.js";
import { extractFileFacts, listSourceFiles, planIndexUpdate, sha1 } from "./indexer.js";
import { emptyIndex, loadIndex, saveIndex } from "./store.js";
import { summarizeFiles } from "./summarize.js";

export interface IndexOptions {
  cwd: string;
  /** Re-index every file regardless of hash. */
  full?: boolean;
  /** Skip LLM summaries (symbols + import graph only; no API key needed). */
  llm?: boolean;
  configPath?: string;
  log?: (msg: string) => void;
}

export interface IndexStats {
  indexed: number;
  removed: number;
  unchanged: number;
  total: number;
}

/** Build or incrementally update .pr-review/index.json. */
export async function runIndex(opts: IndexOptions): Promise<IndexStats> {
  const log = opts.log ?? (() => {});
  const config = await loadConfig(opts.cwd, opts.configPath);
  const previous = (await loadIndex(opts.cwd)) ?? emptyIndex();
  const files = await listSourceFiles(opts.cwd, config);

  const plan = await planIndexUpdate(opts.cwd, files, previous, opts.full ?? false);
  log(`${files.length} source files; ${plan.stale.length} to (re)index, ${plan.removed.length} removed.`);

  const next: CodemapIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: { ...previous.files },
  };
  for (const removed of plan.removed) delete next.files[removed];

  // Deterministic half: symbols + imports.
  for (const file of plan.stale) {
    const content = plan.contents.get(file)!;
    const facts = extractFileFacts(opts.cwd, file, content);
    next.files[file] = {
      hash: sha1(content),
      summary: previous.files[file]?.summary ?? "",
      symbols: facts.symbols,
      imports: facts.imports,
    };
  }

  // LLM half: summaries for stale files.
  if (opts.llm !== false && plan.stale.length > 0) {
    const inputs = plan.stale.map((p) => ({ path: p, content: plan.contents.get(p)! }));
    const summaries = await summarizeFiles(inputs, (done, total) =>
      log(`Summarized ${done}/${total} files…`),
    );
    for (const [p, summary] of summaries) {
      if (next.files[p] && summary) next.files[p].summary = summary;
    }
  }

  await saveIndex(opts.cwd, next);

  return {
    indexed: plan.stale.length,
    removed: plan.removed.length,
    unchanged: files.length - plan.stale.length,
    total: files.length,
  };
}
