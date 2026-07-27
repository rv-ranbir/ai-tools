#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import pc from "picocolors";
import { getModel, runIndex } from "repocairn";
import {
  getBbPrDiff,
  listBbFindingIds,
  listBbWontFixFindingIds,
  postBbReview,
  resolveBbRef,
  type BbRef,
} from "./bitbucket/comments.js";
import {
  getGlMrDiff,
  listGlFindingIds,
  listGlWontFixFindingIds,
  postGlReview,
  resolveGlRef,
  type GlDiffRefs,
  type GlRef,
} from "./gitlab/comments.js";
import { loadConfig } from "./config.js";
import { getPrDiff, getPrHeadSha, makeOctokit, parseRepoSlug, type PrRef } from "./diff/github.js";
import { getLocalDiff } from "./diff/local.js";
import { listPostedFindingIds, listWontFixFindingIds, postReview } from "./github/comments.js";
import { formatReport, shouldFail } from "./report/cli.js";
import {
  buildJsonReport,
  formatRunSummaryLine,
  loadPreviousFindings,
  loadPreviousIds,
  writeJsonReport,
} from "./report/json.js";
import { runReview } from "./review.js";
import { appendSuppressionIds, loadSuppressions } from "./suppressions.js";
import { SEVERITIES, type Severity } from "./types.js";

const program = new Command();
const log = (msg: string) => console.error(pc.dim(msg));

program
  .name("secondpair")
  .description("secondpair — the second pair of eyes: LLM PR reviewer with a persistent repo memory (repocairn) for whole-project context")
  .version("0.1.0");

program
  .command("index")
  .description("Build or incrementally update the repo memory (.repocairn/index.json)")
  .option("--full", "re-index every file regardless of content hash", false)
  .option("--no-llm", "skip LLM summaries (symbols + import graph only; no API key needed)")
  .option("--dir <path>", "repository root", process.cwd())
  .option("--config <path>", "path to .pr-review.yml")
  .action(async (opts) => {
    const cwd = path.resolve(opts.dir);
    const config = await loadConfig(cwd, opts.config);
    const stats = await runIndex({
      cwd,
      full: opts.full,
      llm: opts.llm,
      ignore: config.ignore,
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
  .description("Review a diff (local branch, staged changes, or a GitHub/Bitbucket/GitLab PR)")
  .option("--staged", "review staged changes instead of branch vs base", false)
  .option("--base <ref>", "base ref for the local diff (default: auto-detected origin/main)")
  .option("--pr <number>", "pull request number/id to review", (v) => parseInt(v, 10))
  .option(
    "--repo <owner/name>",
    "repository (GitHub owner/name, Bitbucket workspace/repo_slug, or GitLab group/project; default from CI env vars)",
  )
  .option(
    "--host <host>",
    "github | bitbucket | gitlab (default: detected from CI env vars, else github)",
  )
  .option("--json <path>", "write findings JSON to this path", "pr-review-report.json")
  .option("--post", "post findings as inline PR review comments", false)
  .option("--fail-on <severity>", `exit 1 at/above this severity (${SEVERITIES.join("|")}); overrides config`)
  .option("--no-context", "review the diff without codemap context")
  .option("--dir <path>", "repository root", process.cwd())
  .option("--config <path>", "path to .pr-review.yml")
  .option("--suppressions <path>", "path to .pr-review-suppressions.yml")
  .option("--write-suppressions", "append won’t-fix finding ids to .pr-review-suppressions.yml", false)
  .action(async (opts) => {
    const cwd = path.resolve(opts.dir);
    const config = await loadConfig(cwd, opts.config);
    if (opts.writeSuppressions) config.write_suppressions = true;
    if (opts.failOn) {
      if (!SEVERITIES.includes(opts.failOn)) {
        throw new Error(`--fail-on must be one of: ${SEVERITIES.join(", ")}`);
      }
      config.fail_on = opts.failOn as Severity;
    }

    const env = process.env;
    const host: "github" | "bitbucket" | "gitlab" =
      opts.host ??
      (env.BITBUCKET_WORKSPACE || env.BITBUCKET_PR_ID
        ? "bitbucket"
        : env.GITLAB_CI
          ? "gitlab"
          : "github");
    if (host !== "github" && host !== "bitbucket" && host !== "gitlab") {
      throw new Error(`--host must be github, bitbucket, or gitlab, got "${opts.host}".`);
    }
    const bbPrAvailable = host === "bitbucket" && (opts.pr != null || env.BITBUCKET_PR_ID);
    const glMrAvailable = host === "gitlab" && (opts.pr != null || env.CI_MERGE_REQUEST_IID);

    let diffText: string;
    let changeDescription: string;
    let prRef: PrRef | null = null;
    let octokit: ReturnType<typeof makeOctokit> | null = null;
    let bbRef: BbRef | null = null;
    let glRef: GlRef | null = null;
    let glDiffRefs: GlDiffRefs | null = null;

    if (glMrAvailable) {
      glRef = resolveGlRef(opts.repo, opts.pr);
      log(`Fetching diff for project ${decodeURIComponent(glRef.projectId)} MR !${glRef.mrIid} (GitLab)…`);
      const mr = await getGlMrDiff(glRef);
      diffText = mr.diffText;
      glDiffRefs = mr.diffRefs;
      changeDescription = `MR !${glRef.mrIid} in ${decodeURIComponent(glRef.projectId)}`;
    } else if (bbPrAvailable) {
      bbRef = resolveBbRef(opts.repo, opts.pr);
      log(`Fetching diff for ${bbRef.workspace}/${bbRef.repoSlug} PR #${bbRef.prId} (Bitbucket)…`);
      diffText = await getBbPrDiff(bbRef);
      changeDescription = `PR #${bbRef.prId} in ${bbRef.workspace}/${bbRef.repoSlug}`;
    } else if (opts.pr != null) {
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

    const jsonPath = path.resolve(cwd, opts.json);
    const previousIds = await loadPreviousIds(jsonPath);
    const previousFindings = await loadPreviousFindings(jsonPath);
    const suppressions = await loadSuppressions(cwd, opts.suppressions);
    const ephemeral = new Set<string>();
    try {
      if (glRef) {
        for (const id of await listGlWontFixFindingIds(glRef)) ephemeral.add(id);
      } else if (bbRef) {
        for (const id of await listBbWontFixFindingIds(bbRef)) ephemeral.add(id);
      } else if (prRef && octokit) {
        for (const id of await listWontFixFindingIds(octokit, prRef)) ephemeral.add(id);
      }
    } catch (e) {
      log(`Warning: could not scan won’t-fix replies: ${e instanceof Error ? e.message : e}`);
    }
    const suppressedIds = new Set([...suppressions.ids, ...ephemeral]);

    if (opts.post) {
      if (glRef) {
        for (const id of await listGlFindingIds(glRef)) previousIds.add(id);
      } else if (bbRef) {
        for (const id of await listBbFindingIds(bbRef)) previousIds.add(id);
      } else if (prRef && octokit) {
        for (const id of await listPostedFindingIds(octokit, prRef)) previousIds.add(id);
      }
    }

    const result = await runReview({
      cwd,
      diffText,
      config,
      changeDescription,
      useContext: opts.context,
      previousIds,
      previousFindings,
      suppressedIds,
      log,
    });

    if (config.write_suppressions && ephemeral.size) {
      const n = await appendSuppressionIds(cwd, ephemeral, opts.suppressions);
      if (n) log(`Wrote ${n} new id(s) to suppressions file.`);
    }

    console.log("\n" + formatReport(result) + "\n");

    await writeJsonReport(
      jsonPath,
      buildJsonReport(result, {
        model: getModel(),
        changeDescription,
        usedContext: result.usedContext,
      }),
    );
    log(`Wrote ${jsonPath}`);
    console.error(formatRunSummaryLine(result.stats));

    const failed = shouldFail(result.findings, config.fail_on);

    if (opts.post) {
      if (glRef && glDiffRefs) {
        await postGlReview({ ref: glRef, diffRefs: glDiffRefs, result, failed, log });
      } else if (bbRef) {
        await postBbReview({ ref: bbRef, result, failed, log });
      } else if (prRef && octokit) {
        const headSha = await getPrHeadSha(octokit, prRef);
        await postReview({ octokit, pr: prRef, headSha, result, failed, log });
      } else {
        throw new Error("--post requires a PR (--pr, or Bitbucket/GitLab CI env vars).");
      }
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
