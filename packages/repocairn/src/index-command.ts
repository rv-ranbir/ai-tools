import type { CodemapIndex } from "./types.js";
import { extractFileFacts, isIndexableSourcePath, listSourceFiles, planIndexUpdate, sha1 } from "./indexer.js";
import { emptyIndex, loadIndex, saveIndex } from "./store.js";
import { summarizeFiles } from "./summarize.js";

export interface IndexOptions {
  cwd: string;
  /** Re-index every file regardless of hash. */
  full?: boolean;
  /** Skip LLM summaries when false (symbols + import graph only; no API key needed). */
  llm?: boolean;
  /** Extra ignore globs on top of the built-in defaults. */
  ignore?: string[];
  /**
   * When set, only touch these paths (plus `remove` for explicit deletes).
   * Skips full-tree prune of unrelated missing files.
   */
  only?: string[];
  /** Explicit paths to drop from the index (e.g. staged deletes). */
  remove?: string[];
  log?: (msg: string) => void;
}

export interface IndexStats {
  indexed: number;
  removed: number;
  unchanged: number;
  total: number;
}

/** Build or incrementally update .repocairn/index.json. */
export async function runIndex(opts: IndexOptions): Promise<IndexStats> {
  const log = opts.log ?? (() => {});
  const ignore = opts.ignore ?? [];
  const previous = (await loadIndex(opts.cwd)) ?? emptyIndex();

  const onlyMode = opts.only !== undefined || opts.remove !== undefined;
  const onlyUpdate = (opts.only ?? []).filter((f) => isIndexableSourcePath(f, ignore));
  const explicitRemove = new Set(
    (opts.remove ?? []).filter((f) => isIndexableSourcePath(f, ignore) || previous.files[f]),
  );

  let files: string[];
  if (onlyMode) {
    files = onlyUpdate;
  } else {
    files = await listSourceFiles(opts.cwd, ignore);
  }

  if (onlyMode && onlyUpdate.length === 0 && explicitRemove.size === 0) {
    log("Nothing to update.");
    return { indexed: 0, removed: 0, unchanged: 0, total: Object.keys(previous.files).length };
  }

  const plan = await planIndexUpdate(opts.cwd, files, previous, opts.full ?? false);

  const removed = onlyMode
    ? [...explicitRemove].filter((f) => previous.files[f])
    : plan.removed;

  log(
    onlyMode
      ? `${plan.stale.length} to (re)index, ${removed.length} removed (only-mode).`
      : `${files.length} source files; ${plan.stale.length} to (re)index, ${removed.length} removed.`,
  );

  const next: CodemapIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: { ...previous.files },
  };
  for (const path of removed) delete next.files[path];

  for (const file of plan.stale) {
    const content = plan.contents.get(file)!;
    const facts = await extractFileFacts(opts.cwd, file, content);
    next.files[file] = {
      hash: sha1(content),
      summary: previous.files[file]?.summary ?? "",
      symbols: facts.symbols,
      imports: facts.imports,
    };
  }

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

  const total = Object.keys(next.files).length;
  return {
    indexed: plan.stale.length,
    removed: removed.length,
    unchanged: onlyMode
      ? onlyUpdate.length - plan.stale.length
      : files.length - plan.stale.length,
    total,
  };
}
