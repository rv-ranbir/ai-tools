import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { readJsonFile } from "./store.js";

export const CODENGRAM_YML = ".codengram.yml";
export const PACKAGE_JSON = "package.json";

const hooksSchema = z
  .object({
    "pre-commit": z.boolean().optional(),
    "pre-push": z.boolean().optional(),
  })
  .strict()
  .optional();

const configSchema = z
  .object({
    hooks: hooksSchema,
    llm: z.boolean().optional(),
    ignore: z.array(z.string()).optional(),
  })
  .strict();

export type CodengramConfig = {
  hooks: { "pre-commit": boolean; "pre-push": boolean };
  llm: boolean;
  ignore: string[];
};

export const DEFAULT_CODENGRAM_CONFIG: CodengramConfig = {
  hooks: { "pre-commit": true, "pre-push": true },
  llm: false,
  ignore: [],
};

export function mergeCodengramConfig(partial: z.infer<typeof configSchema> | undefined): CodengramConfig {
  const p = partial ?? {};
  return {
    hooks: {
      "pre-commit": p.hooks?.["pre-commit"] ?? DEFAULT_CODENGRAM_CONFIG.hooks["pre-commit"],
      "pre-push": p.hooks?.["pre-push"] ?? DEFAULT_CODENGRAM_CONFIG.hooks["pre-push"],
    },
    llm: p.llm ?? DEFAULT_CODENGRAM_CONFIG.llm,
    ignore: p.ignore ?? [],
  };
}

/**
 * Load config: `.codengram.yml` wins over `package.json#codengram`, else defaults.
 */
export async function loadCodengramConfig(cwd: string): Promise<CodengramConfig> {
  const ymlPath = path.join(cwd, CODENGRAM_YML);
  if (existsSync(ymlPath)) {
    const raw = YAML.parse(await readFile(ymlPath, "utf8")) ?? {};
    return parsePartial(raw, CODENGRAM_YML);
  }

  const pkgPath = path.join(cwd, PACKAGE_JSON);
  if (existsSync(pkgPath)) {
    let pkg: unknown;
    try {
      pkg = await readJsonFile(pkgPath);
    } catch {
      return { ...DEFAULT_CODENGRAM_CONFIG, ignore: [] };
    }
    if (pkg && typeof pkg === "object" && "codengram" in pkg) {
      const block = (pkg as { codengram: unknown }).codengram;
      if (block !== undefined && block !== null) {
        return parsePartial(block, `${PACKAGE_JSON}#codengram`);
      }
    }
  }

  return { ...DEFAULT_CODENGRAM_CONFIG, ignore: [] };
}

function parsePartial(raw: unknown, label: string): CodengramConfig {
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${label}:\n${issues}`);
  }
  return mergeCodengramConfig(parsed.data);
}

/** Serialize config for `.codengram.yml`. */
export function formatCodengramYml(config: CodengramConfig): string {
  return YAML.stringify({
    hooks: config.hooks,
    llm: config.llm,
    ignore: config.ignore,
  });
}
