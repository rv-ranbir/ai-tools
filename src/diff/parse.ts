import type { FileDiff, FileStatus, Hunk } from "../types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff (git diff / GitHub PR diff) into structured FileDiff entries.
 * Tracks, per file, the set of new-file line numbers that were added — these are
 * the lines the LLM may comment on and the lines GitHub accepts review comments on.
 */
export function parseDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diffText.split("\n");

  let current: FileDiff | null = null;
  let currentHunk: Hunk | null = null;
  let newLineNo = 0;

  const flushFile = () => {
    if (current) files.push(current);
    current = null;
    currentHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      flushFile();
      const paths = parseDiffGitLine(line);
      current = {
        path: paths.newPath,
        oldPath: paths.oldPath !== paths.newPath ? paths.oldPath : undefined,
        status: "modified",
        hunks: [],
        changedLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      current.path = current.oldPath ?? current.path;
      current.oldPath = undefined;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // Path info already derived from the diff --git / rename lines.
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newLines: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      current.hunks.push(currentHunk);
      newLineNo = currentHunk.newStart;
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push(line);
      current.changedLines.push(newLineNo);
      newLineNo++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push(line);
    } else if (line.startsWith(" ") || line === "") {
      currentHunk.lines.push(line);
      newLineNo++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      currentHunk.lines.push(line);
    } else {
      // Anything else ends the hunk (e.g. next file header handled above).
      currentHunk = null;
    }
  }
  flushFile();

  return files;
}

function parseDiffGitLine(line: string): { oldPath: string; newPath: string } {
  // diff --git a/src/foo.ts b/src/foo.ts  (paths with spaces may be quoted)
  const rest = line.slice("diff --git ".length);
  const quoted = /^"a\/(.+)" "b\/(.+)"$/.exec(rest);
  if (quoted) return { oldPath: unescapeGitPath(quoted[1]), newPath: unescapeGitPath(quoted[2]) };
  // Unquoted: split on " b/" — handles the common case; paths containing " b/" must be quoted by git anyway.
  const idx = rest.lastIndexOf(" b/");
  if (idx === -1) return { oldPath: rest, newPath: rest };
  const oldPath = rest.slice(0, idx).replace(/^a\//, "");
  const newPath = rest.slice(idx + 3);
  return { oldPath, newPath };
}

function unescapeGitPath(p: string): string {
  return p.replace(/\\(.)/g, "$1");
}

/** Render a FileDiff back to annotated text with explicit new-file line numbers for the prompt. */
export function renderDiffForPrompt(file: FileDiff): string {
  const out: string[] = [`### ${file.status.toUpperCase()}: ${file.path}`];
  if (file.oldPath) out.push(`(renamed from ${file.oldPath})`);
  for (const hunk of file.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    let newNo = hunk.newStart;
    for (const l of hunk.lines) {
      if (l.startsWith("+")) {
        out.push(`${String(newNo).padStart(5)} + ${l.slice(1)}`);
        newNo++;
      } else if (l.startsWith("-")) {
        out.push(`      - ${l.slice(1)}`);
      } else if (l.startsWith("\\")) {
        out.push(`        ${l}`);
      } else {
        out.push(`${String(newNo).padStart(5)}   ${l.slice(1)}`);
        newNo++;
      }
    }
  }
  return out.join("\n");
}
