import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isIgnored as matchesIgnorePatterns, matchesGlob } from "repomind";
import { CATEGORIES, SEVERITIES, type Category, type ReviewConfig } from "./types.js";

export { matchesGlob };

const defaultCategories = Object.fromEntries(CATEGORIES.map((c) => [c, true])) as Record<
  Category,
  boolean
>;

export const DEFAULT_CONFIG: ReviewConfig = {
  fail_on: "high",
  min_confidence: 0.5,
  ignore: [],
  context_token_budget: 8000,
  custom_instructions: "",
  categories: defaultCategories,
};

const configSchema = z
  .object({
    fail_on: z.enum(SEVERITIES as [string, ...string[]]).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    ignore: z.array(z.string()).optional(),
    context_token_budget: z.number().int().positive().optional(),
    custom_instructions: z.string().optional(),
    categories: z.partialRecord(z.enum(CATEGORIES as [string, ...string[]]), z.boolean()).optional(),
  })
  .strict();

export const CONFIG_FILENAME = ".pr-review.yml";

/** Load .pr-review.yml from the repo root, merged over defaults. */
export async function loadConfig(cwd: string, configPath?: string): Promise<ReviewConfig> {
  const file = configPath ?? path.join(cwd, CONFIG_FILENAME);
  if (!existsSync(file)) {
    if (configPath) throw new Error(`Config file not found: ${configPath}`);
    return { ...DEFAULT_CONFIG };
  }
  const raw = YAML.parse(await readFile(file, "utf8")) ?? {};
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${path.basename(file)}:\n${issues}`);
  }
  return mergeConfig(parsed.data);
}

export function mergeConfig(partial: z.infer<typeof configSchema>): ReviewConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    fail_on: (partial.fail_on ?? DEFAULT_CONFIG.fail_on) as ReviewConfig["fail_on"],
    ignore: partial.ignore ?? [],
    categories: { ...defaultCategories, ...(partial.categories ?? {}) },
  };
}

/** True when the path matches repomind's built-in ignores or this config's patterns. */
export function isIgnored(filePath: string, config: ReviewConfig): boolean {
  return matchesIgnorePatterns(filePath, config.ignore);
}
