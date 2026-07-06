import { structuredCall } from "../llm/client.js";
import { fileSummariesSchema } from "../llm/schema.js";
import { SUMMARIZE_SYSTEM_PROMPT, buildSummarizeUserPrompt } from "../llm/prompt.js";

const FILES_PER_BATCH = 8;
const MAX_BATCH_CHARS = 120_000;

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
