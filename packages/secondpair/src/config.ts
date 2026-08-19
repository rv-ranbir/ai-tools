import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isIgnored as matchesIgnorePatterns, matchesGlob } from "repocairn";
import { compileRedactPatterns } from "./redact.js";
import { CATEGORIES, SEVERITIES, type Category, type ReviewConfig, type Severity } from "./types.js";

export { matchesGlob };

const defaultCategories = Object.fromEntries(CATEGORIES.map((c) => [c, true])) as Record<
  Category,
  boolean
>;

export const DEFAULT_CONFIG: ReviewConfig = {
  fail_on: "off",
  min_confidence: 0.5,
  ignore: [],
  context_token_budget: 8000,
  context_snippets: 3,
  custom_instructions: "",
  custom_instructions_file: ".pr-review-instructions.md",
  categories: defaultCategories,
  temperature: null,
  limits: { max_findings_per_file: 5, max_total: 30 },
  self_critique: false,
  redact_secrets: true,
  redact_patterns: [],
  write_suppressions: false,
  huge_pr_token_threshold: 120_000,
  signal_detector: true,
  parallel_agents: true,
};

const configSchema = z
  .object({
    fail_on: z.enum([...SEVERITIES, "off"] as unknown as [string, ...string[]]).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    ignore: z.array(z.string()).optional(),
    context_token_budget: z.number().int().positive().optional(),
    context_snippets: z.number().int().min(0).optional(),
    custom_instructions: z.string().optional(),
    custom_instructions_file: z.string().optional(),
    categories: z.partialRecord(z.enum(CATEGORIES as [string, ...string[]]), z.boolean()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    limits: z
      .object({
        max_findings_per_file: z.number().int().positive().optional(),
        max_total: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    self_critique: z.boolean().optional(),
    redact_secrets: z.boolean().optional(),
    redact_patterns: z.array(z.string()).optional(),
    write_suppressions: z.boolean().optional(),
    huge_pr_token_threshold: z.number().int().positive().nullable().optional(),
    signal_detector: z.boolean().optional(),
    parallel_agents: z.boolean().optional(),
  })
  .strict();

export const CONFIG_FILENAME = ".pr-review.yml";

export const SECONDPAIR_DIR = ".secondpair";
const SECONDPAIR_DIR_CANDIDATES = ["instructions.mdc", "instructions.md"];

/**
 * `.secondpair/instructions.mdc` or `.secondpair/instructions.md` — same
 * convention as `.claude`/`.cursor`/`.repocairn`. Checked before
 * custom_instructions_file; wins over it when both exist.
 */
async function findDirInstructions(cwd: string): Promise<string | null> {
  for (const name of SECONDPAIR_DIR_CANDIDATES) {
    const file = path.join(cwd, SECONDPAIR_DIR, name);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Resolves the effective custom_instructions content, none of it mandatory:
 * 1. `.secondpair/instructions.mdc|.md` (repo-standard location, highest precedence)
 * 2. `custom_instructions_file` (repo-relative path, default `.pr-review-instructions.md`)
 * 3. inline `custom_instructions` in .pr-review.yml (fallback, used as-is if neither file exists)
 * This only ever feeds the CUSTOM REVIEW INSTRUCTIONS prompt section — it
 * never touches REVIEW_SYSTEM_PROMPT, so it can't override review behavior,
 * only add project-specific guidance on top of it.
 */
async function applyInstructionsFile(cwd: string, config: ReviewConfig): Promise<ReviewConfig> {
  const dirFile = await findDirInstructions(cwd);
  if (dirFile) {
    const content = (await readFile(dirFile, "utf8")).trim();
    if (content) return { ...config, custom_instructions: content };
  }

  if (!config.custom_instructions_file) return config;
  const file = path.isAbsolute(config.custom_instructions_file)
    ? config.custom_instructions_file
    : path.join(cwd, config.custom_instructions_file);
  if (!existsSync(file)) return config;
  const content = (await readFile(file, "utf8")).trim();
  return content ? { ...config, custom_instructions: content } : config;
}

/** Load .pr-review.yml from the repo root, merged over defaults. */
export async function loadConfig(cwd: string, configPath?: string): Promise<ReviewConfig> {
  const file = configPath ?? path.join(cwd, CONFIG_FILENAME);
  if (!existsSync(file)) {
    if (configPath) throw new Error(`Config file not found: ${configPath}`);
    return applyInstructionsFile(cwd, { ...DEFAULT_CONFIG });
  }
  const raw = YAML.parse(await readFile(file, "utf8")) ?? {};
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${path.basename(file)}:\n${issues}`);
  }
  compileRedactPatterns(parsed.data.redact_patterns ?? []);
  return applyInstructionsFile(cwd, mergeConfig(parsed.data));
}

export function mergeConfig(partial: z.infer<typeof configSchema>): ReviewConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    fail_on: (partial.fail_on ?? DEFAULT_CONFIG.fail_on) as ReviewConfig["fail_on"],
    ignore: partial.ignore ?? [],
    categories: { ...defaultCategories, ...(partial.categories ?? {}) },
    temperature: partial.temperature ?? DEFAULT_CONFIG.temperature,
    limits: { ...DEFAULT_CONFIG.limits, ...(partial.limits ?? {}) },
    redact_secrets: partial.redact_secrets ?? DEFAULT_CONFIG.redact_secrets,
    redact_patterns: partial.redact_patterns ?? DEFAULT_CONFIG.redact_patterns,
    write_suppressions: partial.write_suppressions ?? DEFAULT_CONFIG.write_suppressions,
  };
}

/** Apply CLI-flag overrides (e.g. --fail-on, --write-suppressions) onto a loaded config. */
export function applyCliOverrides(
  config: ReviewConfig,
  overrides: { failOn?: string; writeSuppressions?: boolean },
): ReviewConfig {
  const next = { ...config };
  if (overrides.writeSuppressions) next.write_suppressions = true;
  if (overrides.failOn) {
    if (overrides.failOn !== "off" && !SEVERITIES.includes(overrides.failOn as Severity)) {
      throw new Error(`--fail-on must be one of: ${SEVERITIES.join(", ")}, off`);
    }
    next.fail_on = overrides.failOn as Severity | "off";
  }
  return next;
}

/** True when the path matches repocairn's built-in ignores or this config's patterns. */
export function isIgnored(filePath: string, config: ReviewConfig): boolean {
  return matchesIgnorePatterns(filePath, config.ignore);
}
