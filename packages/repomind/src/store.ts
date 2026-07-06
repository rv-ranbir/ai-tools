import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CodemapIndex } from "./types.js";

export const INDEX_DIR = ".repomind";
export const INDEX_FILE = "index.json";

export function indexPath(cwd: string): string {
  return path.join(cwd, INDEX_DIR, INDEX_FILE);
}

export async function loadIndex(cwd: string): Promise<CodemapIndex | null> {
  const file = indexPath(cwd);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(await readFile(file, "utf8"));
  if (raw?.version !== 1 || typeof raw.files !== "object") {
    throw new Error(`Unrecognized codemap index format in ${file}. Re-run: repomind index --full`);
  }
  return raw as CodemapIndex;
}

export async function saveIndex(cwd: string, index: CodemapIndex): Promise<void> {
  const file = indexPath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  // Sort keys for stable diffs when the index is committed.
  const sorted: CodemapIndex = {
    version: 1,
    generatedAt: index.generatedAt,
    files: Object.fromEntries(Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(file, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

export function emptyIndex(): CodemapIndex {
  return { version: 1, generatedAt: new Date().toISOString(), files: {} };
}
