import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { readJsonFile } from "./store.js";

export const REPOCAIRN_YML = ".repocairn.yml";
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

export type RepoCairnConfig = {
  hooks: { "pre-commit": boolean; "pre-push": boolean };
  llm: boolean;
  ignore: string[];
};

export const DEFAULT_REPOCAIRN_CONFIG: RepoCairnConfig = {
  hooks: { "pre-commit": true, "pre-push": true },
  llm: false,
  ignore: [],
};

export function mergeRepoCairnConfig(partial: z.infer<typeof configSchema> | undefined): RepoCairnConfig {
  const p = partial ?? {};
  return {
    hooks: {
      "pre-commit": p.hooks?.["pre-commit"] ?? DEFAULT_REPOCAIRN_CONFIG.hooks["pre-commit"],
      "pre-push": p.hooks?.["pre-push"] ?? DEFAULT_REPOCAIRN_CONFIG.hooks["pre-push"],
    },
    llm: p.llm ?? DEFAULT_REPOCAIRN_CONFIG.llm,
    ignore: p.ignore ?? [],
  };
}

/**
 * Load config: `.repocairn.yml` wins over `package.json#repocairn`, else defaults.
 */
export async function loadRepoCairnConfig(cwd: string): Promise<RepoCairnConfig> {
  const ymlPath = path.join(cwd, REPOCAIRN_YML);
  if (existsSync(ymlPath)) {
    const raw = YAML.parse(await readFile(ymlPath, "utf8")) ?? {};
    return parsePartial(raw, REPOCAIRN_YML);
  }

  const pkgPath = path.join(cwd, PACKAGE_JSON);
  if (existsSync(pkgPath)) {
    let pkg: unknown;
    try {
      pkg = await readJsonFile(pkgPath);
    } catch {
      return { ...DEFAULT_REPOCAIRN_CONFIG, ignore: [] };
    }
    if (pkg && typeof pkg === "object" && "repocairn" in pkg) {
      const block = (pkg as { repocairn: unknown }).repocairn;
      if (block !== undefined && block !== null) {
        return parsePartial(block, `${PACKAGE_JSON}#repocairn`);
      }
    }
  }

  return { ...DEFAULT_REPOCAIRN_CONFIG, ignore: [] };
}

function parsePartial(raw: unknown, label: string): RepoCairnConfig {
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${label}:\n${issues}`);
  }
  return mergeRepoCairnConfig(parsed.data);
}

/** Serialize config for `.repocairn.yml`. */
export function formatRepoCairnYml(config: RepoCairnConfig): string {
  return YAML.stringify({
    hooks: config.hooks,
    llm: config.llm,
    ignore: config.ignore,
  });
}
