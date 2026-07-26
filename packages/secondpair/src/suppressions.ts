import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const SUPPRESSIONS_FILENAME = ".pr-review-suppressions.yml";

const schema = z
  .object({
    ids: z.array(z.string()).optional(),
  })
  .strict();

export interface Suppressions {
  ids: Set<string>;
}

export async function loadSuppressions(
  cwd: string,
  configPath?: string,
): Promise<Suppressions> {
  const file = configPath ?? path.join(cwd, SUPPRESSIONS_FILENAME);
  if (!existsSync(file)) {
    if (configPath) throw new Error(`Suppressions file not found: ${configPath}`);
    return { ids: new Set() };
  }
  const raw = YAML.parse(await readFile(file, "utf8")) ?? {};
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${path.basename(file)}:\n${issues}`);
  }
  return { ids: new Set((parsed.data.ids ?? []).map((id) => id.toLowerCase())) };
}

export async function appendSuppressionIds(
  cwd: string,
  ids: Iterable<string>,
  filePath?: string,
): Promise<number> {
  const file = filePath ?? path.join(cwd, SUPPRESSIONS_FILENAME);
  const existing = existsSync(file)
    ? await loadSuppressions(cwd, filePath)
    : { ids: new Set<string>() };
  let added = 0;
  for (const raw of ids) {
    const id = raw.toLowerCase();
    if (!existing.ids.has(id)) {
      existing.ids.add(id);
      added++;
    }
  }
  if (added === 0) return 0;

  const sorted = [...existing.ids].sort();
  await writeFile(file, YAML.stringify({ ids: sorted }), "utf8");
  return added;
}
