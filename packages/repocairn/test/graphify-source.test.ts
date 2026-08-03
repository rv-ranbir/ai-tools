import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/index-command.js";
import { loadIndex } from "../src/store.js";

const exec = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "repocairn-graphify-"));
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function commitAll() {
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-m", "commit"], { cwd: dir });
}

function writeGraph(nodes: unknown[], edges: unknown[]) {
  return fs.mkdir(path.join(dir, "graphify-out"), { recursive: true }).then(() =>
    fs.writeFile(
      path.join(dir, "graphify-out", "graph.json"),
      JSON.stringify({ nodes, edges }),
      "utf8",
    ),
  );
}

describe("graphify graph.json as extraction source", () => {
  it("uses graphify's symbols/imports instead of repocairn's own extractor when a graph exists", async () => {
    await fs.writeFile(path.join(dir, "a.py"), "def unused():\n  pass\n");
    await fs.writeFile(path.join(dir, "b.py"), "def also_unused():\n  pass\n");
    await writeGraph(
      [
        { id: "a_run", label: "def run", source_file: "a.py", file_type: "code" },
        { id: "b_helper", label: "def helper", source_file: "b.py", file_type: "code" },
      ],
      [{ source: "a_run", target: "b_helper", relation: "imports_from" }],
    );
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);

    // Graphify's fabricated symbol ("def run"), not what repocairn's real Python
    // extractor would have found in a.py ("def unused") — proves the graph won.
    expect(index?.files["a.py"]?.symbols).toEqual(["def run"]);
    expect(index?.files["a.py"]?.imports).toEqual(["b.py"]);
  });

  it("falls back to repocairn's own extractor when no graph exists", async () => {
    await fs.writeFile(path.join(dir, "a.py"), "def real_symbol():\n  pass\n");
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);

    expect(index?.files["a.py"]?.symbols).toContain("def real_symbol");
  });

  it("treats cross-file calls as imports (monorepo bare-specifier imports resolve to calls, not imports_from)", async () => {
    await fs.writeFile(path.join(dir, "consumer.ts"), "runIndex();\n");
    await fs.writeFile(path.join(dir, "lib.ts"), "export function runIndex() {}\n");
    await writeGraph(
      [
        { id: "consumer_top", label: "consumer.ts", source_file: "consumer.ts", file_type: "code" },
        { id: "lib_runindex", label: "runIndex", source_file: "lib.ts", file_type: "code" },
      ],
      [{ source: "consumer_top", target: "lib_runindex", relation: "calls" }],
    );
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);

    expect(index?.files["consumer.ts"]?.imports).toEqual(["lib.ts"]);
  });

  it("ignores non-code and same-file edges", async () => {
    await fs.writeFile(path.join(dir, "a.py"), "x = 1\n");
    await fs.writeFile(path.join(dir, "notes.md"), "# notes\n");
    await writeGraph(
      [
        { id: "a_x", label: "x", source_file: "a.py", file_type: "code" },
        { id: "a_y", label: "y", source_file: "a.py", file_type: "code" },
        { id: "concept_1", label: "Some Concept", source_file: "notes.md", file_type: "concept" },
      ],
      [
        { source: "a_x", target: "a_y", relation: "imports_from" }, // same file, ignored
        { source: "a_x", target: "concept_1", relation: "semantically_similar_to" }, // LLM-inferred, not real coupling
      ],
    );
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);

    expect(index?.files["a.py"]?.imports).toEqual([]);
    expect(index?.files["a.py"]?.symbols).toEqual(expect.arrayContaining(["x", "y"]));
  });
});
