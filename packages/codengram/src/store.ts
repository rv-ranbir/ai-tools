import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CodemapIndex } from "./types.js";

export const INDEX_DIR = ".codengram";
export const INDEX_FILE = "index.json";

export function indexPath(cwd: string): string {
  return path.join(cwd, INDEX_DIR, INDEX_FILE);
}

/** Read + parse a JSON file, tolerating a UTF-8 BOM (common on Windows). */
export async function readJsonFile<T = unknown>(file: string): Promise<T> {
  const text = await readFile(file, "utf8");
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(body) as T;
}

export async function loadIndex(cwd: string): Promise<CodemapIndex | null> {
  const file = indexPath(cwd);
  if (!existsSync(file)) return null;
  const raw = await readJsonFile<Record<string, unknown>>(file);
  if (raw?.version !== 1 || typeof raw.files !== "object") {
    throw new Error(`Unrecognized codemap index format in ${file}. Re-run: codengram index --full`);
  }
  return raw as unknown as CodemapIndex;
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
