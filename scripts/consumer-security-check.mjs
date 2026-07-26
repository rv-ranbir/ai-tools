#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("Run through npm: npm run security:consumers");
}

function npm(args, cwd, allowFailure = false) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function audit(consumer, label) {
  const result = npm(["audit", "--json"], consumer, true);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label}: npm audit returned invalid JSON\n${result.stdout}\n${result.stderr}`);
  }
  const total = report.metadata?.vulnerabilities?.total;
  if (result.status !== 0 || total !== 0) {
    throw new Error(`${label}: npm audit reports ${total ?? "unknown"} vulnerabilities`);
  }
  return total;
}

async function installConsumer(directory, tarballs, label) {
  await mkdir(directory);
  npm(["init", "-y"], directory);
  npm(["install", ...tarballs, "--ignore-scripts"], directory);

  const sdk = JSON.parse(
    await readFile(
      path.join(directory, "node_modules/codengram/node_modules/@modelcontextprotocol/sdk/package.json"),
      "utf8",
    ),
  );
  const hono = JSON.parse(
    await readFile(
      path.join(directory, "node_modules/codengram/node_modules/@hono/node-server/package.json"),
      "utf8",
    ),
  );
  if (hono.version !== "2.0.12") {
    throw new Error(`${label}: expected @hono/node-server 2.0.12, found ${hono.version}`);
  }
  const total = await audit(directory, label);
  console.log(`${label}: codengram -> @modelcontextprotocol/sdk@${sdk.version} -> @hono/node-server@${hono.version}; audit total ${total}`);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "ai-tools-consumer-security-"));
const requestedOutput = process.argv[2];
const output = requestedOutput ? path.resolve(root, requestedOutput) : path.join(temporary, "packages");

try {
  await mkdir(output, { recursive: true });
  const stagedCodengram = path.join(temporary, "codengram");
  await cp(path.join(root, "packages/codengram"), stagedCodengram, {
    recursive: true,
    filter: (source) =>
      !["node_modules", "package-lock.json", "npm-shrinkwrap.json"].includes(path.basename(source)),
  });

  npm(["install", "--ignore-scripts", "--package-lock=false"], stagedCodengram);
  const codengramPack = npm(
    ["pack", stagedCodengram, "--pack-destination", output, "--json"],
    root,
  );
  const codengram = JSON.parse(codengramPack.stdout)[0];
  const bundledPaths = new Set(codengram.files.map(({ path: file }) => file));
  for (const required of [
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/@hono/node-server/package.json",
  ]) {
    if (!bundledPaths.has(required)) {
      throw new Error(`codengram tarball is missing bundled ${required}`);
    }
  }

  const secondpairPack = npm(
    ["pack", "--workspace", "secondpair", "--pack-destination", output, "--json"],
    root,
  );
  const secondpair = JSON.parse(secondpairPack.stdout)[0];
  const codengramTarball = path.join(output, codengram.filename);
  const secondpairTarball = path.join(output, secondpair.filename);

  await installConsumer(
    path.join(temporary, "codengram-consumer"),
    [codengramTarball],
    "codengram consumer",
  );
  await installConsumer(
    path.join(temporary, "secondpair-consumer"),
    [codengramTarball, secondpairTarball],
    "secondpair consumer",
  );

  console.log(`Packed ${codengram.filename} and ${secondpair.filename}; consumer security passed.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
