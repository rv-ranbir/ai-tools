import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadRepoCairnConfig, type RepoCairnConfig } from "./config.js";
import { listPushPaths, listStagedPaths, type HookPhase } from "./git-paths.js";
import { runIndex, type IndexStats } from "./index-command.js";
import { INDEX_DIR, INDEX_FILE } from "./store.js";

export type { HookPhase };
export const HOOK_MARKER = "# repocairn:hook";

export interface HookResult {
  skipped?: boolean;
  reason?: string;
  stats?: IndexStats;
}

export async function runHook(
  cwd: string,
  phase: HookPhase,
  opts: { stdinText?: string; log?: (msg: string) => void } = {},
): Promise<HookResult> {
  const log = opts.log ?? (() => {});
  const config = await loadRepoCairnConfig(cwd);

  if (!config.hooks[phase]) {
    return { skipped: true, reason: `hooks.${phase} is false` };
  }

  let update: string[];
  let removed: string[];
  if (phase === "pre-commit") {
    ({ update, removed } = await listStagedPaths(cwd, config.ignore));
  } else {
    ({ update, removed } = await listPushPaths(cwd, opts.stdinText ?? "", config.ignore));
  }

  if (update.length === 0 && removed.length === 0) {
    log("Nothing to update.");
    return { skipped: true, reason: "no paths", stats: { indexed: 0, removed: 0, unchanged: 0, total: 0 } };
  }

  const stats = await runIndex({
    cwd,
    only: update,
    remove: removed,
    llm: config.llm,
    ignore: config.ignore,
    log,
  });
  if (phase === "pre-commit") {
    await stageIndexFile(cwd, log);
  }
  return { stats };
}

/** Stage the updated index so the commit that changed the code also carries the fresh index. */
async function stageIndexFile(cwd: string, log: (msg: string) => void): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    await exec("git", ["add", "--", `${INDEX_DIR}/${INDEX_FILE}`], { cwd });
  } catch {
    // index file may be gitignored (local-only brain) — that's fine
    log("Note: could not stage .repocairn/index.json (gitignored?).");
  }
}

function hookScriptBody(phase: HookPhase): string {
  return `#!/usr/bin/env bash
${HOOK_MARKER}
# Managed by \`repocairn init\`. Do not remove the marker line above.
set -e
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# REPOCAIRN_BIN may be a multi-word command line (e.g. "node /path/cli.js")
if [ -n "\${REPOCAIRN_BIN:-}" ]; then
  eval "$REPOCAIRN_BIN hook ${phase}"
  exit $?
fi

resolve_repocairn() {
  if [ -x "$ROOT/node_modules/.bin/repocairn" ]; then
    echo "$ROOT/node_modules/.bin/repocairn"
    return
  fi
  if command -v repocairn >/dev/null 2>&1; then
    command -v repocairn
    return
  fi
  return 1
}

BIN="$(resolve_repocairn)" || {
  echo "repocairn: not found. Install the package or set REPOCAIRN_BIN." >&2
  exit 1
}

${phase === "pre-push" ? `exec "$BIN" hook pre-push` : `exec "$BIN" hook pre-commit`}
`;
}

export interface InstallHooksOptions {
  force?: boolean;
  config?: RepoCairnConfig;
}

export async function installHooks(cwd: string, opts: InstallHooksOptions = {}): Promise<string[]> {
  const config = opts.config ?? (await loadRepoCairnConfig(cwd));
  const gitDir = await resolveGitDir(cwd);
  const hooksDir = path.join(gitDir, "hooks");
  await fs.mkdir(hooksDir, { recursive: true });

  const steps: string[] = [];
  for (const phase of ["pre-commit", "pre-push"] as HookPhase[]) {
    if (!config.hooks[phase]) continue;
    const file = path.join(hooksDir, phase);
    const body = hookScriptBody(phase);

    if (existsSync(file)) {
      const existing = await fs.readFile(file, "utf8");
      if (existing.includes(HOOK_MARKER)) {
        await fs.writeFile(file, body, { mode: 0o755 });
        steps.push(`Updated .git/hooks/${phase}`);
        continue;
      }
      if (!opts.force) {
        throw new Error(
          `.git/hooks/${phase} already exists and is not a repocairn hook. Re-run with --force to replace, or remove it first.`,
        );
      }
    }

    await fs.writeFile(file, body, { mode: 0o755 });
    steps.push(`Installed .git/hooks/${phase}`);
  }
  return steps;
}

async function resolveGitDir(cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec("git", ["rev-parse", "--git-dir"], { cwd });
    const dir = stdout.trim();
    return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
  } catch {
    throw new Error(`Not a git repository: ${cwd}`);
  }
}
