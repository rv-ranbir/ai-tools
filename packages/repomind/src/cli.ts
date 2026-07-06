#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import pc from "picocolors";
import { selectContext } from "./graph.js";
import { runIndex } from "./index-command.js";
import { runMcpServer } from "./mcp.js";
import { getFileInfo, searchSymbols } from "./query.js";
import { indexPath, loadIndex } from "./store.js";

const program = new Command();
const log = (msg: string) => console.error(pc.dim(msg));

const collect = (v: string, acc: string[]) => [...acc, v];

async function requireIndex(cwd: string) {
  const index = await loadIndex(cwd);
  if (!index) {
    throw new Error(`No index at ${indexPath(cwd)}. Run \`repomind index\` first.`);
  }
  return index;
}

program
  .name("repomind")
  .description(
    "Persistent repository memory for AI tools — symbols, import graph and LLM summaries per file",
  )
  .version("0.1.0");

program
  .command("index")
  .description("Build or incrementally update the repo index (.repomind/index.json)")
  .option("--full", "re-index every file regardless of content hash", false)
  .option("--no-llm", "skip LLM summaries (symbols + import graph only; no API key needed)")
  .option("--ignore <glob>", "extra ignore pattern (repeatable)", collect, [] as string[])
  .option("--dir <path>", "repository root", process.cwd())
  .action(async (opts) => {
    const cwd = path.resolve(opts.dir);
    const stats = await runIndex({ cwd, full: opts.full, llm: opts.llm, ignore: opts.ignore, log });
    console.log(
      pc.green(
        `Index updated: ${stats.indexed} indexed, ${stats.unchanged} unchanged, ${stats.removed} removed (${stats.total} files).`,
      ),
    );
  });

program
  .command("context <files...>")
  .description("Print token-budgeted repo context (importers, imports, summaries) for the given files")
  .option("--budget <tokens>", "approximate token budget", (v) => parseInt(v, 10), 8000)
  .option("--dir <path>", "repository root", process.cwd())
  .action(async (files: string[], opts) => {
    const index = await requireIndex(path.resolve(opts.dir));
    const { entries, rendered } = selectContext(index, files, opts.budget);
    if (entries.length === 0) {
      console.log(pc.yellow("No context found for those files in the index."));
      return;
    }
    console.log(rendered);
  });

program
  .command("query <term>")
  .description("Search indexed file paths and exported symbols; use `query <path> --file` for one file's full record")
  .option("--file", "treat the term as an exact file path and print its full record", false)
  .option("--limit <n>", "max results", (v) => parseInt(v, 10), 20)
  .option("--dir <path>", "repository root", process.cwd())
  .action(async (term: string, opts) => {
    const index = await requireIndex(path.resolve(opts.dir));
    if (opts.file) {
      const info = getFileInfo(index, term);
      if (!info) throw new Error(`"${term}" is not in the index.`);
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    const matches = searchSymbols(index, term, opts.limit);
    if (matches.length === 0) {
      console.log(pc.yellow(`No matches for "${term}".`));
      return;
    }
    for (const m of matches) {
      console.log(pc.bold(m.path));
      for (const s of m.symbols) console.log(`  ${s}`);
      if (m.summary) console.log(pc.dim(`  ${m.summary}`));
    }
  });

program
  .command("mcp")
  .description("Run an MCP server (stdio) exposing the repo memory to AI tools")
  .option("--dir <path>", "repository root", process.cwd())
  .action(async (opts) => {
    await runMcpServer(path.resolve(opts.dir));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(2);
});
