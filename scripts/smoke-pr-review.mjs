#!/usr/bin/env node
/**
 * Smoke harness for secondpair.
 * Run after every change to that package: `npm run smoke:pr-review`
 *
 * Always (no API key):
 *   1. typecheck/build
 *   2. secondpair unit tests
 *   3. CLI --help
 *   4. dist integration: fingerprint, reconcile, suppressions, report JSON, comment format
 *
 * Optional live (needs ANTHROPIC_API_KEY or OPENAI_/OPENROUTER_):
 *   5. tiny git repo → `pr-review review --no-context` (skipped if no key)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages/secondpair/dist/cli.js");

let failed = 0;
function ok(msg) {
  console.log(`  ✔ ${msg}`);
}
function fail(msg, err) {
  failed++;
  console.error(`  ✖ ${msg}`);
  if (err) console.error(err instanceof Error ? err.stack ?? err.message : err);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")}\n${r.stdout ?? ""}\n${r.stderr ?? ""}\nexit ${r.status}`,
    );
  }
  return r;
}

console.log("\n=== smoke:pr-review ===\n");

// 1. Build
console.log("1. build");
try {
  run("npm", ["run", "build"]);
  if (!existsSync(CLI)) throw new Error(`missing ${CLI}`);
  ok("tsc build + cli.js present");
} catch (e) {
  fail("build", e);
  process.exit(1);
}

// 2. Unit tests (package only)
console.log("\n2. unit tests (secondpair)");
try {
  run("npx", ["vitest", "run", "packages/secondpair"]);
  ok("vitest packages/secondpair");
} catch (e) {
  fail("unit tests", e);
}

// 3. CLI help
console.log("\n3. CLI help");
try {
  const help = run("node", [CLI, "--help"]);
  if (!help.stdout.includes("secondpair")) throw new Error("unexpected --help output");
  const reviewHelp = run("node", [CLI, "review", "--help"]);
  if (!reviewHelp.stdout.includes("--suppressions")) {
    throw new Error("review --help missing --suppressions (P0 regression)");
  }
  if (!reviewHelp.stdout.includes("--write-suppressions")) {
    throw new Error("review --help missing --write-suppressions");
  }
  if (!reviewHelp.stdout.includes("--post")) throw new Error("review --help missing --post");
  ok("cli --help + review suppression options");
} catch (e) {
  fail("CLI help", e);
}

// 4. Dist integration
console.log("\n4. dist integration (stability + suppressions + report)");
try {
  const {
    fingerprintFinding,
    normalizeTitle,
    embedFindingId,
    parseFindingId,
  } = await import("../packages/secondpair/dist/finding-id.js");
  const { reconcileFindings } = await import("../packages/secondpair/dist/reconcile.js");
  const { loadSuppressions } = await import("../packages/secondpair/dist/suppressions.js");
  const { formatCommentBody, AGENT_MARKER } = await import(
    "../packages/secondpair/dist/github/comments.js"
  );
  const { buildJsonReport, loadPreviousIds, writeJsonReport } = await import(
    "../packages/secondpair/dist/report/json.js"
  );
  const { shouldFail } = await import("../packages/secondpair/dist/report/cli.js");

  const finding = {
    file: "src/x.ts",
    start_line: 1,
    end_line: 2,
    severity: "high",
    category: "bug",
    confidence: 0.9,
    title: "Off-by-one!",
    body: "details",
    suggestion: null,
  };
  const id = fingerprintFinding(finding);
  if (id.length !== 16) throw new Error(`bad id length ${id}`);
  if (fingerprintFinding({ ...finding, title: "off by one" }) !== id) {
    throw new Error("normalizeTitle fingerprint mismatch");
  }
  if (normalizeTitle("Hello World!!") !== "hello world") throw new Error("normalizeTitle");

  const body = formatCommentBody({ ...finding, id });
  if (!body.includes(AGENT_MARKER)) throw new Error("missing agent marker");
  if (parseFindingId(body) !== id) throw new Error("id not embedded in comment");
  if (!embedFindingId("x", id).includes(id)) throw new Error("embedFindingId");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-smoke-"));
  try {
    await fs.writeFile(path.join(dir, ".pr-review-suppressions.yml"), `ids:\n  - ${id}\n`);
    const sup = await loadSuppressions(dir);
    if (!sup.ids.has(id)) throw new Error("suppressions load failed");

    const identified = { ...finding, id };
    const rec = reconcileFindings([identified], {
      previousIds: [],
      suppressedIds: sup.ids,
    });
    if (rec.active.length !== 0 || rec.reconciliation.suppressed[0] !== id) {
      throw new Error("suppressed finding still active");
    }

    const otherId = createHash("sha1").update("other").digest("hex").slice(0, 16);
    const rec2 = reconcileFindings([{ ...finding, id: otherId, title: "Other issue" }], {
      previousIds: [otherId],
    });
    if (rec2.toPost.length !== 0 || !rec2.reconciliation.persistent.includes(otherId)) {
      throw new Error("persistent reconcile failed");
    }

    const reportPath = path.join(dir, "pr-review-report.json");
    const report = buildJsonReport(
      {
        findings: [{ ...finding, id: otherId }],
        summary: "ok",
        dropped: [],
        reconciliation: rec2.reconciliation,
        findingsToPost: [],
      },
      { model: "smoke", changeDescription: "smoke", usedContext: false },
    );
    await writeJsonReport(reportPath, report);
    const prev = await loadPreviousIds(reportPath);
    if (!prev.has(otherId)) throw new Error("loadPreviousIds missed id");

    if (shouldFail([{ ...finding, id }], "high") !== true) throw new Error("shouldFail");
    if (shouldFail([], "high") !== false) throw new Error("shouldFail empty");

    ok("fingerprint · comment id · suppress · reconcile · report JSON · shouldFail");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
} catch (e) {
  fail("dist integration", e);
}

// 5. Optional live review
console.log("\n5. live review (optional)");
const hasKey = !!(
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.OPENROUTER_API_KEY ||
  process.env.PR_REVIEW_API_KEY
);
if (!hasKey) {
  console.log("  · skipped (no LLM API key in env)");
} else {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-smoke-live-"));
  try {
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "smoke@test"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "smoke"], { cwd: dir });
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "sum.ts"), "export const sum = (a: number, b: number) => a + b;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    await fs.writeFile(
      path.join(dir, "src", "sum.ts"),
      "export const sum = (a: number, b: number) => a - b;\n",
    );
    const r = spawnSync(
      "node",
      [CLI, "review", "--dir", dir, "--no-context", "--json", "pr-review-report.json"],
      { cwd: dir, encoding: "utf8", env: process.env },
    );
    if (r.status !== 0 && r.status !== 1) {
      throw new Error(`live review exited ${r.status}\n${r.stderr}\n${r.stdout}`);
    }
    if (!existsSync(path.join(dir, "pr-review-report.json"))) {
      throw new Error("live review did not write report");
    }
    const report = JSON.parse(await fs.readFile(path.join(dir, "pr-review-report.json"), "utf8"));
    if (!report.meta || !Array.isArray(report.findings)) throw new Error("bad live report shape");
    ok(`live review ok (exit ${r.status}, findings=${report.findings.length})`);
  } catch (e) {
    fail("live review", e);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

console.log("");
if (failed) {
  console.error(`smoke:pr-review FAILED (${failed} check(s))\n`);
  process.exit(1);
}
console.log("smoke:pr-review PASSED\n");
