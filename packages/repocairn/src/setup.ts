import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "./store.js";

const RULE_MARKER = "<!-- repocairn:rule -->";

const RULE = `
${RULE_MARKER}
## RepoCairn — repo memory

This repo has a committed memory index (\`.repocairn/index.json\`). For orientation
questions — where is symbol X, what does file Y do, what depends on these files —
prefer the repocairn MCP tools (\`search_symbols\`, \`file_info\`, \`get_context\`)
before grep/reading whole files. Fall back to the CLI (\`repocairn query <term>\`,
\`repocairn context <files...>\`) if the MCP server is unavailable.
`;

const SKILL = `---
name: repocairn
description: Query the committed repo memory (.repocairn/index.json). Use before grep/Read for orientation — where a symbol lives, what a file does, who imports it, what context matters for a change.
---

# RepoCairn

This repo keeps a persistent index at \`.repocairn/index.json\`: per file, its
exported symbols, import graph, and a one-paragraph summary.

Prefer these over grepping / reading whole files for orientation:

- MCP tools (if the repocairn server is registered): \`search_symbols\` (where is X),
  \`file_info\` (what does this file do), \`get_context\` (importers + imports for a
  set of files, token-budgeted).
- CLI fallback: \`repocairn query <term>\`, \`repocairn query <path> --file\`,
  \`repocairn context <files...>\`.

If the index is missing or stale, run \`repocairn index\` (add \`--no-llm\` when no
API key is available). Editing code still requires reading the real files — the
index is for orientation, not exact lines.
`;

export interface Target {
  id: string;
  label: string;
  /** Any of these paths existing in the repo enables the target. */
  detect: string[];
  /** mcpServers-style JSON config to merge the server into. */
  mcp?: { file: string; key?: string };
  /** Markdown rules file the usage rule is appended to. */
  rules: { file: string; frontmatter?: string };
  /** Directory to install a SKILL.md into (Claude Code skill pattern). */
  skillDir?: string;
}

export const TARGETS: Target[] = [
  {
    id: "claude",
    label: "Claude Code",
    detect: [".claude", "CLAUDE.md"],
    mcp: { file: ".mcp.json" },
    rules: { file: "CLAUDE.md" },
    skillDir: ".claude/skills/repocairn",
  },
  {
    id: "cursor",
    label: "Cursor",
    detect: [".cursor"],
    mcp: { file: ".cursor/mcp.json" },
    rules: {
      file: ".cursor/rules/repocairn.mdc",
      frontmatter: "---\ndescription: RepoCairn repo memory\nalwaysApply: true\n---\n",
    },
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    detect: [".github/copilot-instructions.md", ".vscode"],
    mcp: { file: ".vscode/mcp.json", key: "servers" },
    rules: { file: ".github/copilot-instructions.md" },
  },
  {
    id: "windsurf",
    label: "Windsurf",
    detect: [".windsurf", ".windsurfrules"],
    rules: { file: ".windsurfrules" },
  },
  {
    id: "cline",
    label: "Cline",
    detect: [".clinerules"],
    rules: { file: ".clinerules" },
  },
  {
    id: "roo",
    label: "Roo Code",
    detect: [".roorules", ".roo"],
    rules: { file: ".roorules" },
  },
  {
    id: "continue",
    label: "Continue",
    detect: [".continue"],
    rules: { file: ".continue/rules/repocairn.md" },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    detect: ["GEMINI.md", ".gemini"],
    mcp: { file: ".gemini/settings.json" },
    rules: { file: "GEMINI.md" },
  },
  {
    id: "zed",
    label: "Zed",
    detect: [".zed"],
    rules: { file: ".rules" },
  },
  {
    // AGENTS.md standard: Codex CLI, OpenCode, Jules, Amp and others read it.
    id: "agents",
    label: "AGENTS.md (Codex, OpenCode, …)",
    detect: ["AGENTS.md"],
    rules: { file: "AGENTS.md" },
  },
];

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/** Merge repocairn into an mcpServers-style JSON config, preserving other entries. */
async function mergeMcpConfig(file: string, key = "mcpServers"): Promise<boolean> {
  let config: Record<string, any> = {};
  if (await exists(file)) {
    config = await readJsonFile(file);
  }
  config[key] ??= {};
  if (config[key].repocairn) return false;
  config[key].repocairn = { command: "repocairn", args: ["mcp"] };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/** Append the usage rule to a rules file unless the marker is already there. */
async function appendRule(file: string, frontmatter?: string): Promise<boolean> {
  const current = (await exists(file)) ? await fs.readFile(file, "utf8") : "";
  if (current.includes(RULE_MARKER)) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const prefix = current === "" && frontmatter ? frontmatter : "";
  await fs.writeFile(file, prefix + current + RULE);
  return true;
}

export interface SetupOptions {
  /** Target ids to set up, skipping detection. Empty/absent = detect. */
  targets?: string[];
}

/** Detect installed AI tools in the repo and wire repocairn in. Returns steps performed. */
export async function runSetup(cwd: string, opts: SetupOptions = {}): Promise<string[]> {
  let active: Target[];
  if (opts.targets?.length) {
    active = opts.targets.map((id) => {
      const t = TARGETS.find((t) => t.id === id);
      if (!t) {
        throw new Error(`Unknown target "${id}". Known: ${TARGETS.map((t) => t.id).join(", ")}`);
      }
      return t;
    });
  } else {
    active = [];
    for (const t of TARGETS) {
      for (const d of t.detect) {
        if (await exists(path.join(cwd, d))) {
          active.push(t);
          break;
        }
      }
    }
    if (active.length === 0) {
      throw new Error(
        `No AI tool detected. Force one with --target <id> (known: ${TARGETS.map((t) => t.id).join(", ")}).`,
      );
    }
  }

  const steps: string[] = [];
  for (const t of active) {
    if (t.mcp && (await mergeMcpConfig(path.join(cwd, t.mcp.file), t.mcp.key))) {
      steps.push(`${t.label}: registered MCP server in ${t.mcp.file}`);
    }
    if (await appendRule(path.join(cwd, t.rules.file), t.rules.frontmatter)) {
      steps.push(`${t.label}: added usage rule to ${t.rules.file}`);
    }
    if (t.skillDir) {
      const skillFile = path.join(cwd, t.skillDir, "SKILL.md");
      if (!(await exists(skillFile))) {
        await fs.mkdir(path.dirname(skillFile), { recursive: true });
        await fs.writeFile(skillFile, SKILL);
        steps.push(`${t.label}: installed skill at ${t.skillDir}/SKILL.md`);
      }
    }
  }
  return steps;
}
