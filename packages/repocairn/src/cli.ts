#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import pc from "picocolors";
import { loadRepoCairnConfig } from "./config.js";
import { selectContext } from "./graph.js";
import { runHook, type HookPhase } from "./hooks.js";
import { runIndex } from "./index-command.js";
import { runInit } from "./init.js";
import { runMcpServer } from "./mcp.js";
import { getFileInfo, searchSymbols } from "./query.js";
import { runSetup, TARGETS } from "./setup.js";
import { indexPath, loadIndex } from "./store.js";

const program = new Command();
const log = (msg: string) => console.error(pc.dim(msg));

const collect = (v: string, acc: string[]) => [...acc, v];

async function requireIndex(cwd: string) {
  const index = await loadIndex(cwd);
  if (!index) {
    throw new Error(`No index at ${indexPath(cwd)}. Run \`repocairn index\` first.`);
  }
  return index;
}

function resolveLlmFlag(configLlm: boolean): boolean {
  if (process.argv.includes("--no-llm")) return false;
  if (process.argv.includes("--llm")) return true;
  return configLlm;
}

program
  .name("repocairn")
  .description(
    "Persistent repository memory for AI tools — symbols, import graph and LLM summaries per file",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Write config, install git hooks, and build the first index")
  .option("--yml", "write .repocairn.yml instead of package.json#repocairn", false)
  .option("--no-hooks", "skip installing git hooks")
  .option("--no-index", "skip the initial index build")
  .option("--force", "overwrite existing hooks / config", false)
  .option("--dir <path>", "repository root", process.cwd())
  .action(async (opts) => {
    const cwd = path.resolve(opts.dir);
    const result = await runInit(cwd, {
      yml: opts.yml,
      noHooks: opts.hooks === false,
      noIndex: opts.index === false,
      force: opts.force,
      log,
    });
    for (const s of result.steps) console.log(pc.green(`✔ ${s}`));
    console.log(
      pc.dim(
        "Next: commit .repocairn/index.json so agents and CI can read the brain. Optional: repocairn setup",
      ),
    );
  });

program
  .command("hook <phase>")
  .description("Run from git hooks: pre-commit | pre-push")
  .option("--dir <path>", "repository root", process.cwd())
  .action(async (phase: string, opts) => {
    if (phase !== "pre-commit" && phase !== "pre-push") {
      throw new Error(`Unknown hook phase "${phase}". Use pre-commit or pre-push.`);
    }
    const cwd = path.resolve(opts.dir);
    let stdinText = "";
    if (phase === "pre-push" && !process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      stdinText = Buffer.concat(chunks).toString("utf8");
    }
    const result = await runHook(cwd, phase as HookPhase, { stdinText, log });
    if (result.skipped && result.reason && result.reason !== "no paths") {
      log(`Skipped: ${result.reason}`);
    }
    if (result.stats) {
      console.log(
        pc.green(
          `Index updated: ${result.stats.indexed} indexed, ${result.stats.removed} removed (${result.stats.total} files).`,
        ),
      );
    }
  });

program
  .command("index")
  .description("Build or incrementally update the repo index (.repocairn/index.json)")
  .option("--full", "re-index every file regardless of content hash", false)
  .option("--llm", "force LLM summaries on (overrides config)")
  .option("--no-llm", "skip LLM summaries (overrides config)")
  .option("--ignore <glob>", "extra ignore pattern (repeatable)", collect, [] as string[])
  .option("--dir <path>", "repository root", process.cwd())
  .action(async (opts) => {
    const cwd = path.resolve(opts.dir);
    const config = await loadRepoCairnConfig(cwd);
    const llm = resolveLlmFlag(config.llm);
    const ignore = [...config.ignore, ...opts.ignore];
    const stats = await runIndex({ cwd, full: opts.full, llm, ignore, log });
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
  .command("setup")
  .description(
    "Detect installed AI tools and wire repocairn in: MCP registration, usage rule, skill",
  )
  .option("-t, --target <id>", "set up a specific target, repeatable (skips detection)", collect, [])
  .option("--list", "list known targets")
  .option("--dir <path>", "repository root", process.cwd())
  .action(async (opts) => {
    if (opts.list) {
      for (const t of TARGETS) console.log(`${t.id.padEnd(10)} ${t.label}`);
      return;
    }
    const steps = await runSetup(path.resolve(opts.dir), { targets: opts.target });
    if (steps.length === 0) {
      console.log(pc.green("Already set up — nothing to do."));
      return;
    }
    for (const s of steps) console.log(pc.green(`✔ ${s}`));
    console.log(pc.dim("Commit these files so the whole team shares the memory."));
  });

program
  .command("mcp")
  .description("Run an MCP server (stdio) exposing the repo memory to AI tools")
  .option("--dir <path>", "repository root", process.cwd())
  .action(async (opts) => {
    await runMcpServer(path.resolve(opts.dir));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
