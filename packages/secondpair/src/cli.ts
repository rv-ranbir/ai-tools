#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import pc from "picocolors";
import { getModel, runIndex } from "repocairn";
import {
  getBbPrDiff,
  getBbPrHeadSha,
  getBbReviewState,
  listBbChangedFiles,
  listBbFindingIds,
  listBbWontFixFindingIds,
  postBbReview,
} from "./bitbucket/comments.js";
import { resolveBbRef, type BbRef } from "./bitbucket/auth.js";
import {
  getGlMrDiff,
  getGlReviewState,
  listGlChangedFiles,
  listGlFindingIds,
  listGlWontFixFindingIds,
  postGlReview,
} from "./gitlab/comments.js";
import { resolveGlRef, type GlRef } from "./gitlab/auth.js";
import type { GlDiffRefs } from "./gitlab/comments.js";
import { applyCliOverrides, loadConfig } from "./config.js";
import {
  getPrDiff,
  getPrHeadSha,
  listChangedFiles,
  makeOctokit,
  parseRepoSlug,
  type PrRef,
} from "./diff/github.js";
import { resolveGhRepoSlug, resolveGhToken } from "./github/auth.js";
import { getLocalDiff } from "./diff/local.js";
import {
  getReviewState,
  listPostedFindingIds,
  listWontFixFindingIds,
  postReview,
} from "./github/comments.js";
import { detectHost } from "./host.js";
import { formatReport, shouldFail } from "./report/cli.js";
import {
  buildJsonReport,
  formatRunSummaryLine,
  loadPreviousFindings,
  loadPreviousIds,
  writeJsonReport,
} from "./report/json.js";
import type { PreviousFinding } from "./reconcile.js";
import { type ReviewState } from "./review-state.js";
import { runReview } from "./review.js";
import { appendSuppressionIds, loadSuppressions } from "./suppressions.js";
import { SEVERITIES, type Finding } from "./types.js";

/** Split embedded review state into re-analyze vs carry-forward buckets. */
function splitFindingsSinceLastReview(
  prev: ReviewState,
  currentHeadSha: string,
  changedSinceLastReview: Set<string>,
  previousIds: Set<string>,
  previousFindings: PreviousFinding[],
  carryForwardFindings: Finding[],
  log: (msg: string) => void,
): Set<string> | undefined {
  for (const f of prev.findings) if (f.id) previousIds.add(f.id);
  if (prev.headSha === currentHeadSha) {
    carryForwardFindings.push(...prev.findings);
    return new Set();
  }
  if (changedSinceLastReview.size === 0) {
    log(
      `Head SHA changed (${prev.headSha.slice(0, 7)} → ${currentHeadSha.slice(0, 7)}) but compare returned no changed files — re-analyzing all ${prev.findings.length} prior finding(s).`,
    );
    previousFindings.push(...prev.findings);
    return undefined;
  }
  for (const f of prev.findings) {
    (changedSinceLastReview.has(f.file) ? previousFindings : carryForwardFindings).push(f);
  }
  return changedSinceLastReview;
}

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
  .option(
    "--fail-on <severity>",
    `exit 1 at/above this severity (${SEVERITIES.join("|")}|off); overrides config`,
  )
  .option("--no-context", "review the diff without codemap context")
  .option("--dir <path>", "repository root", process.cwd())
  .option("--config <path>", "path to .pr-review.yml")
  .option("--suppressions <path>", "path to .pr-review-suppressions.yml")
  .option("--write-suppressions", "append won’t-fix finding ids to .pr-review-suppressions.yml", false)
  .action(async (opts) => {
    const cwd = path.resolve(opts.dir);
    const config = applyCliOverrides(await loadConfig(cwd, opts.config), {
      failOn: opts.failOn,
      writeSuppressions: opts.writeSuppressions,
    });

    const host = detectHost(opts.host);
    const bbPrAvailable = host === "bitbucket" && (opts.pr != null || process.env.BITBUCKET_PR_ID);
    const glMrAvailable = host === "gitlab" && (opts.pr != null || process.env.CI_MERGE_REQUEST_IID);

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
      const slug = resolveGhRepoSlug(opts.repo);
      octokit = makeOctokit(resolveGhToken());
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
    // Posted PR reviews recover state from the summary comment — a local report
    // file must not duplicate ids/findings on top of that embedded state.
    let previousIds = opts.post ? new Set<string>() : await loadPreviousIds(jsonPath);
    let previousFindings: PreviousFinding[] = opts.post ? [] : await loadPreviousFindings(jsonPath);
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

    // Only files changed since the last reviewed commit go back through the
    // LLM; everything else carries its prior findings forward untouched.
    // Recovered from the state blob embedded in the last summary comment/review
    // (see review-state.ts) — the only thing that survives a fresh CI checkout.
    let changedFiles: Set<string> | undefined;
    const carryForwardFindings: Finding[] = [];
    let currentHeadSha: string | undefined;

    if (opts.post) {
      try {
        if (glRef && glDiffRefs) {
          currentHeadSha = glDiffRefs.head_sha;
          const prev = await getGlReviewState(glRef);
          if (prev) {
            changedFiles = splitFindingsSinceLastReview(
              prev,
              currentHeadSha,
              await listGlChangedFiles(glRef, prev.headSha, currentHeadSha),
              previousIds,
              previousFindings,
              carryForwardFindings,
              log,
            );
          } else {
            for (const id of await listGlFindingIds(glRef)) previousIds.add(id);
          }
        } else if (bbRef) {
          currentHeadSha = await getBbPrHeadSha(bbRef);
          const prev = await getBbReviewState(bbRef);
          if (prev) {
            changedFiles = splitFindingsSinceLastReview(
              prev,
              currentHeadSha,
              await listBbChangedFiles(bbRef, prev.headSha, currentHeadSha),
              previousIds,
              previousFindings,
              carryForwardFindings,
              log,
            );
          } else {
            for (const id of await listBbFindingIds(bbRef)) previousIds.add(id);
          }
        } else if (prRef && octokit) {
          currentHeadSha = await getPrHeadSha(octokit, prRef);
          const prev = await getReviewState(octokit, prRef);
          if (prev) {
            changedFiles = splitFindingsSinceLastReview(
              prev,
              currentHeadSha,
              await listChangedFiles(octokit, prRef, prev.headSha, currentHeadSha),
              previousIds,
              previousFindings,
              carryForwardFindings,
              log,
            );
          } else {
            for (const id of await listPostedFindingIds(octokit, prRef)) previousIds.add(id);
          }
        }
      } catch (e) {
        log(`Warning: incremental diff unavailable, falling back to a full review: ${e instanceof Error ? e.message : e}`);
        changedFiles = undefined;
        carryForwardFindings.length = 0;
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
      changedFiles,
      carryForwardFindings,
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
        await postBbReview({ ref: bbRef, result, failed, headSha: currentHeadSha, log });
      } else if (prRef && octokit) {
        const headSha = currentHeadSha ?? (await getPrHeadSha(octokit, prRef));
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
