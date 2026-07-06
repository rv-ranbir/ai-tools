import type { CodemapIndex } from "./types.js";

export interface SymbolMatch {
  path: string;
  /** Matching symbol signatures (empty when only the path matched). */
  symbols: string[];
  summary: string;
}

/** Case-insensitive substring search over file paths and exported symbols. */
export function searchSymbols(index: CodemapIndex, query: string, limit = 20): SymbolMatch[] {
  const q = query.toLowerCase();
  const matches: SymbolMatch[] = [];
  for (const [path, entry] of Object.entries(index.files)) {
    const symbolHits = entry.symbols.filter((s) => s.toLowerCase().includes(q));
    if (symbolHits.length > 0 || path.toLowerCase().includes(q)) {
      matches.push({ path, symbols: symbolHits, summary: entry.summary });
    }
  }
  // Symbol hits rank above path-only hits.
  matches.sort((a, b) => b.symbols.length - a.symbols.length || a.path.localeCompare(b.path));
  return matches.slice(0, limit);
}

export interface FileInfo {
  path: string;
  summary: string;
  symbols: string[];
  imports: string[];
  /** Files that import this one. */
  importers: string[];
}

/** Everything the index knows about one file, including its reverse imports. */
export function getFileInfo(index: CodemapIndex, path: string): FileInfo | null {
  const entry = index.files[path];
  if (!entry) return null;
  const importers = Object.entries(index.files)
    .filter(([, e]) => e.imports.includes(path))
    .map(([p]) => p)
    .sort();
  return { path, summary: entry.summary, symbols: entry.symbols, imports: entry.imports, importers };
}
