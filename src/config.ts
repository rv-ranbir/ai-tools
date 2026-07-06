import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CATEGORIES, SEVERITIES, type Category, type ReviewConfig } from "./types.js";

export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.git/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.map",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/.pr-review/**",
];

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

/** Minimal glob matcher supporting **, * and ? — enough for ignore patterns. */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const rx = globToRegExp(pattern);
  return rx.test(normalized) || rx.test(`/${normalized}`);
}

export function isIgnored(filePath: string, config: ReviewConfig): boolean {
  const patterns = [...DEFAULT_IGNORE, ...config.ignore];
  return patterns.some((p) => matchesGlob(filePath, p));
}

function globToRegExp(pattern: string): RegExp {
  let rx = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // "**/" matches zero or more path segments; bare "**" matches anything.
        if (pattern[i + 2] === "/") {
          rx += "(?:[^/]*/)*";
          i += 3;
        } else {
          rx += ".*";
          i += 2;
        }
      } else {
        rx += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      rx += "[^/]";
      i += 1;
    } else {
      rx += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${rx}$`);
}
