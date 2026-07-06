import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const MAX_DIFF_BUFFER = 64 * 1024 * 1024;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: MAX_DIFF_BUFFER });
  return stdout;
}

async function refExists(ref: string, cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", ref], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function detectBaseRef(cwd: string): Promise<string> {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (await refExists(ref, cwd)) return ref;
  }
  throw new Error(
    "Could not detect a base branch (tried origin/main, origin/master, main, master). Pass --base <ref>.",
  );
}

export interface LocalDiffOptions {
  cwd: string;
  /** Diff staged changes instead of branch-vs-base. */
  staged?: boolean;
  /** Base ref; auto-detected when omitted. */
  base?: string;
}

/** Produce a unified diff from the local repository. */
export async function getLocalDiff(opts: LocalDiffOptions): Promise<string> {
  if (opts.staged) {
    return git(["diff", "--staged", "--no-color"], opts.cwd);
  }
  const base = opts.base ?? (await detectBaseRef(opts.cwd));
  // Triple-dot: diff against the merge-base, matching what a PR would show.
  const diff = await git(["diff", "--no-color", `${base}...HEAD`], opts.cwd);
  if (diff.trim() !== "") return diff;
  // Fall back to uncommitted working-tree changes so `pr-review review` is
  // useful before anything is committed.
  return git(["diff", "--no-color", base], opts.cwd);
}
