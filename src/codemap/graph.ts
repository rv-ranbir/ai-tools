import type { CodemapIndex } from "../types.js";

export interface ContextEntry {
  path: string;
  /** Why this file was selected. */
  relation: "importer" | "import" | "changed";
  summary: string;
  symbols: string[];
}

/** Rough token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function renderEntry(e: ContextEntry): string {
  const parts = [`## ${e.path} (${e.relation})`];
  if (e.summary) parts.push(e.summary);
  if (e.symbols.length) parts.push("Symbols:\n" + e.symbols.map((s) => `- ${s}`).join("\n"));
  return parts.join("\n");
}

/**
 * Select codemap context for a set of changed files, packed into a token budget.
 * Priority: direct importers of changed files (they break when the change is wrong),
 * then direct imports (the APIs the change relies on), then the changed files'
 * own summaries. Deterministic — no LLM call.
 */
export function selectContext(
  index: CodemapIndex,
  changedFiles: string[],
  tokenBudget: number,
): { entries: ContextEntry[]; rendered: string } {
  const changed = new Set(changedFiles);

  // Reverse edge map: file -> files that import it.
  const importers = new Map<string, string[]>();
  for (const [file, entry] of Object.entries(index.files)) {
    for (const imp of entry.imports) {
      if (!importers.has(imp)) importers.set(imp, []);
      importers.get(imp)!.push(file);
    }
  }

  const candidates: ContextEntry[] = [];
  const seen = new Set<string>();

  const push = (file: string, relation: ContextEntry["relation"]) => {
    if (seen.has(file) || changed.has(file) !== (relation === "changed")) return;
    const entry = index.files[file];
    if (!entry) return;
    seen.add(file);
    candidates.push({ path: file, relation, summary: entry.summary, symbols: entry.symbols });
  };

  // Rank importers/imports by how many changed files they touch.
  const importerCounts = new Map<string, number>();
  const importCounts = new Map<string, number>();
  for (const file of changedFiles) {
    for (const imp of importers.get(file) ?? []) {
      importerCounts.set(imp, (importerCounts.get(imp) ?? 0) + 1);
    }
    for (const dep of index.files[file]?.imports ?? []) {
      importCounts.set(dep, (importCounts.get(dep) ?? 0) + 1);
    }
  }

  const byCount = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);

  for (const f of byCount(importerCounts)) push(f, "importer");
  for (const f of byCount(importCounts)) push(f, "import");
  for (const f of changedFiles) push(f, "changed");

  // Pack into budget.
  const selected: ContextEntry[] = [];
  const renderedParts: string[] = [];
  let used = 0;
  for (const entry of candidates) {
    const text = renderEntry(entry);
    const cost = estimateTokens(text);
    if (used + cost > tokenBudget) continue;
    used += cost;
    selected.push(entry);
    renderedParts.push(text);
  }

  return { entries: selected, rendered: renderedParts.join("\n\n") };
}
