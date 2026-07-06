export interface CodemapFileEntry {
  /** sha1 of file content at index time. */
  hash: string;
  /** One-paragraph LLM summary; empty string when indexed with --no-llm. */
  summary: string;
  /** Exported/public symbol signatures. */
  symbols: string[];
  /** Repo-relative paths of resolved relative imports. */
  imports: string[];
}

export interface CodemapIndex {
  version: 1;
  generatedAt: string;
  files: Record<string, CodemapFileEntry>;
}
