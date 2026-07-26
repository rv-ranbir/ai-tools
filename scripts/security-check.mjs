import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("Run this check through npm: npm run security");
  process.exit(1);
}

const audit = spawnSync(process.execPath, [npmCli, "audit", "--json"], {
  cwd: root,
  encoding: "utf8",
});

if (audit.error || !audit.stdout) {
  console.error(audit.error?.message ?? audit.stderr ?? "npm audit returned no JSON");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error(audit.stderr || "npm audit returned invalid JSON");
  process.exit(1);
}

const total = report.metadata?.vulnerabilities?.total;
if (total !== 0) {
  console.error(`Security check failed: npm audit reports ${total ?? "unknown"} vulnerabilities.`);
  process.exit(1);
}

for (const name of ["codengram", "secondpair"]) {
  const installed = realpathSync(join(root, "node_modules", name));
  const workspace = realpathSync(join(root, "packages", name));
  if (installed !== workspace) {
    console.error(`${name} resolves outside the local workspace: ${installed}`);
    process.exit(1);
  }
}

console.log("Security check passed: zero vulnerabilities; local workspaces linked.");
