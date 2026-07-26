import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIndexableSourcePath } from "./indexer.js";

const exec = promisify(execFile);

export type HookPhase = "pre-commit" | "pre-push";

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function filterHookPaths(paths: string[], ignore: string[] = []): string[] {
  return paths.filter((f) => isIndexableSourcePath(f, ignore));
}

/** Staged paths for pre-commit (added/changed/renamed + deleted). */
export async function listStagedPaths(
  cwd: string,
  ignore: string[] = [],
): Promise<{ update: string[]; removed: string[] }> {
  const changed = await gitLines(cwd, [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
  ]);
  const deleted = await gitLines(cwd, [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=D",
  ]);
  return {
    update: filterHookPaths(changed, ignore),
    removed: filterHookPaths(deleted, ignore),
  };
}

/** Files changed in a commit range (pre-push). */
export async function listRangePaths(
  cwd: string,
  range: string,
  ignore: string[] = [],
): Promise<{ update: string[]; removed: string[] }> {
  const changed = await gitLines(cwd, ["diff", "--name-only", "--diff-filter=ACMR", range]);
  const deleted = await gitLines(cwd, ["diff", "--name-only", "--diff-filter=D", range]);
  return {
    update: filterHookPaths(changed, ignore),
    removed: filterHookPaths(deleted, ignore),
  };
}

/**
 * Resolve push ranges from pre-push stdin lines:
 * `<local_ref> <local_sha> <remote_ref> <remote_sha>`
 */
export async function listPushPaths(
  cwd: string,
  stdinText: string,
  ignore: string[] = [],
): Promise<{ update: string[]; removed: string[] }> {
  const lines = stdinText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const update = new Set<string>();
  const removed = new Set<string>();

  const add = async (range: string) => {
    const r = await listRangePaths(cwd, range, ignore);
    for (const p of r.update) update.add(p);
    for (const p of r.removed) removed.add(p);
  };

  if (lines.length === 0) {
    const range = await resolveDefaultPushRange(cwd);
    if (range) await add(range);
    return { update: [...update], removed: [...removed] };
  }

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const localSha = parts[1];
    const remoteSha = parts[3];
    const zero = /^0+$/;
    if (zero.test(localSha)) continue;
    const range = zero.test(remoteSha) ? localSha : `${remoteSha}..${localSha}`;
    await add(range);
  }

  return { update: [...update], removed: [...removed] };
}

async function resolveDefaultPushRange(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "@{push}"], { cwd });
    const remoteBranch = stdout.trim();
    if (remoteBranch) return `${remoteBranch}..HEAD`;
  } catch {
    /* fall through */
  }
  try {
    const { stdout } = await exec("git", ["merge-base", "HEAD", "origin/main"], { cwd });
    const base = stdout.trim();
    if (base) return `${base}..HEAD`;
  } catch {
    /* fall through */
  }
  try {
    await exec("git", ["rev-parse", "HEAD~1"], { cwd });
    return "HEAD~1..HEAD";
  } catch {
    return null;
  }
}
