#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import pc from "picocolors";
import { runIndex } from "./codemap/index-command.js";
import { loadConfig } from "./config.js";
import { getPrDiff, getPrHeadSha, makeOctokit, parseRepoSlug, type PrRef } from "./diff/github.js";
import { getLocalDiff } from "./diff/local.js";
import { postReview } from "./github/comments.js";
import { getModel } from "./llm/client.js";
import { formatReport, shouldFail } from "./report/cli.js";
import { buildJsonReport, writeJsonReport } from "./report/json.js";
import { runReview } from "./review.js";
import { SEVERITIES, type Severity } from "./types.js";

const program = new Command();
const log = (msg: string) => console.error(pc.dim(msg));

program
  .name("pr-review")
  .description("LLM-powered PR reviewer with a persistent repo codemap for whole-project context")
  .version("0.1.0");

program
  .command("index")
  .description("Build or incrementally update the repo codemap (.pr-review/index.json)")
  .option("--full", "re-index every file regardless of content hash", false)
  .option("--no-llm", "skip LLM summaries (symbols + import graph only; no API key needed)")
  .option("--dir <path>", "repository root", process.cwd())
  .option("--config <path>", "path to .pr-review.yml")
  .action(async (opts) => {
    const cwd = path.resolve(opts.dir);
    const stats = await runIndex({
      cwd,
      full: opts.full,
      llm: opts.llm,
      configPath: opts.config,
      log,
    });
    console.log(
      pc.green(
        `Codemap updated: ${stats.indexed} indexed, ${stats.unchanged} unchanged, ${stats.removed} removed (${stats.total} files).`,
      ),
    );
  });

program
  .command("review")
  .description("Review a diff (local branch, staged changes, or a GitHub PR)")
  .option("--staged", "review staged changes instead of branch vs base", false)
  .option("--base <ref>", "base ref for the local diff (default: auto-detected origin/main)")
  .option("--pr <number>", "GitHub PR number to review", (v) => parseInt(v, 10))
  .option("--repo <owner/name>", "GitHub repository (default: GITHUB_REPOSITORY env var)")
  .option("--json <path>", "write findings JSON to this path", "pr-review-report.json")
  .option("--post", "post findings as PR review comments (requires --pr and GITHUB_TOKEN)", false)
  .option("--fail-on <severity>", `exit 1 at/above this severity (${SEVERITIES.join("|")}); overrides config`)
  .option("--no-context", "review the diff without codemap context")
  .option("--dir <path>", "repository root", process.cwd())
  .option("--config <path>", "path to .pr-review.yml")
  .action(async (opts) => {
    const cwd = path.resolve(opts.dir);
    const config = await loadConfig(cwd, opts.config);
    if (opts.failOn) {
      if (!SEVERITIES.includes(opts.failOn)) {
        throw new Error(`--fail-on must be one of: ${SEVERITIES.join(", ")}`);
      }
      config.fail_on = opts.failOn as Severity;
    }

    let diffText: string;
    let changeDescription: string;
    let prRef: PrRef | null = null;
    let octokit: ReturnType<typeof makeOctokit> | null = null;

    if (opts.pr != null) {
      const slug = opts.repo ?? process.env.GITHUB_REPOSITORY;
      if (!slug) throw new Error("Pass --repo owner/name or set GITHUB_REPOSITORY when using --pr.");
      octokit = makeOctokit(process.env.GITHUB_TOKEN);
      prRef = { ...parseRepoSlug(slug), pull_number: opts.pr };
      log(`Fetching diff for ${slug}#${opts.pr}…`);
      diffText = await getPrDiff(octokit, prRef);
      changeDescription = `PR #${opts.pr} in ${slug}`;
    } else {
      diffText = await getLocalDiff({ cwd, staged: opts.staged, base: opts.base });
      changeDescription = opts.staged
        ? "staged changes"
        : `local diff vs ${opts.base ?? "auto-detected base"}`;
    }

    if (diffText.trim() === "") {
      console.log(pc.yellow("Nothing to review — the diff is empty."));
      return;
    }

    const result = await runReview({
      cwd,
      diffText,
      config,
      changeDescription,
      useContext: opts.context,
      log,
    });

    console.log("\n" + formatReport(result) + "\n");

    const jsonPath = path.resolve(cwd, opts.json);
    await writeJsonReport(
      jsonPath,
      buildJsonReport(result, {
        model: getModel(),
        changeDescription,
        usedContext: result.usedContext,
      }),
    );
    log(`Wrote ${jsonPath}`);

    const failed = shouldFail(result.findings, config.fail_on);

    if (opts.post) {
      if (!prRef || !octokit) throw new Error("--post requires --pr.");
      const headSha = await getPrHeadSha(octokit, prRef);
      await postReview({ octokit, pr: prRef, headSha, result, failed, log });
    }

    if (failed) {
      console.error(pc.red(`✖ Failing: findings at or above "${config.fail_on}" severity.`));
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(2);
});
