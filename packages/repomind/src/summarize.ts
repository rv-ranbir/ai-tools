import { z } from "zod";
import { structuredCall } from "./llm.js";

const FILES_PER_BATCH = 8;
const MAX_BATCH_CHARS = 120_000;
const MAX_CHARS_PER_FILE = 24_000;

export const fileSummariesSchema = z.object({
  summaries: z.array(
    z.object({
      path: z.string(),
      summary: z
        .string()
        .describe("One paragraph: the file's purpose, key behaviors, and notable invariants"),
    }),
  ),
});

export type FileSummaries = z.infer<typeof fileSummariesSchema>;

export const SUMMARIZE_SYSTEM_PROMPT = `You summarize source files for a repository context index used by AI tools. For each file, write ONE paragraph (2-4 sentences) covering: the file's purpose, its key exported behaviors, and any invariants or conventions a reader of dependent code should know. Be concrete and dense — this text is injected into future prompts under a tight token budget. No filler like "This file contains".`;

export function buildSummarizeUserPrompt(files: { path: string; content: string }[]): string {
  const blocks = files.map((f) => {
    const truncated =
      f.content.length > MAX_CHARS_PER_FILE
        ? f.content.slice(0, MAX_CHARS_PER_FILE) + "\n… (truncated)"
        : f.content;
    return `## FILE: ${f.path}\n\`\`\`\n${truncated}\n\`\`\``;
  });
  return `Summarize each of the following files. Return one summary per file, keyed by the exact path shown.\n\n${blocks.join("\n\n")}`;
}

/**
 * Generate one-paragraph summaries for the given files, batched to limit
 * request count. Returns a map path -> summary; files the model skipped map to "".
 */
export async function summarizeFiles(
  files: { path: string; content: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const batches: { path: string; content: string }[][] = [];

  let batch: { path: string; content: string }[] = [];
  let batchChars = 0;
  for (const f of files) {
    if (batch.length >= FILES_PER_BATCH || (batchChars + f.content.length > MAX_BATCH_CHARS && batch.length > 0)) {
      batches.push(batch);
      batch = [];
      batchChars = 0;
    }
    batch.push(f);
    batchChars += f.content.length;
  }
  if (batch.length) batches.push(batch);

  let done = 0;
  for (const b of batches) {
    const output = await structuredCall({
      system: SUMMARIZE_SYSTEM_PROMPT,
      user: buildSummarizeUserPrompt(b),
      schema: fileSummariesSchema,
      schemaName: "file_summaries",
      maxTokens: 8000,
    });
    const byPath = new Map(output.summaries.map((s) => [s.path, s.summary]));
    for (const f of b) {
      result.set(f.path, byPath.get(f.path) ?? "");
    }
    done += b.length;
    onProgress?.(done, files.length);
  }

  return result;
}
