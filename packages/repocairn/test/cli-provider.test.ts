import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { structuredCall } from "../src/llm.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "repocairn-cli-"));
  vi.stubEnv("REPOCAIRN_PROVIDER", "cli");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

const schema = z.object({ greeting: z.string() });

async function fakeCli(js: string): Promise<void> {
  const file = path.join(dir, "fake-cli.js");
  await fs.writeFile(file, js);
  vi.stubEnv("REPOCAIRN_CLI_COMMAND", `node "${file}"`);
}

describe("cli provider structuredCall", () => {
  it("pipes the prompt on stdin and parses JSON stdout", async () => {
    await fakeCli(`
      let input = "";
      process.stdin.on("data", (c) => (input += c));
      process.stdin.on("end", () => {
        if (!input.includes("JSON schema")) { console.error("no schema in prompt"); process.exit(2); }
        console.log(JSON.stringify({ greeting: "hello from cli" }));
      });
    `);
    const out = await structuredCall({ system: "sys", user: "usr", schema, schemaName: "t" });
    expect(out.greeting).toBe("hello from cli");
  });

  it("tolerates prose and markdown fences around the JSON", async () => {
    await fakeCli(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        console.log('Sure! Here is the result:\\n\\n\`\`\`json\\n{"greeting":"fenced"}\\n\`\`\`');
      });
    `);
    const out = await structuredCall({ system: "sys", user: "usr", schema, schemaName: "t" });
    expect(out.greeting).toBe("fenced");
  });

  it("repairs once when the first response fails validation", async () => {
    const marker = path.join(dir, "second-run").replace(/\\/g, "\\\\");
    await fakeCli(`
      const fs = require("node:fs");
      process.stdin.resume();
      process.stdin.on("end", () => {
        if (fs.existsSync("${marker}")) {
          console.log(JSON.stringify({ greeting: "repaired" }));
        } else {
          fs.writeFileSync("${marker}", "1");
          console.log(JSON.stringify({ wrong_key: true }));
        }
      });
    `);
    const out = await structuredCall({ system: "sys", user: "usr", schema, schemaName: "t" });
    expect(out.greeting).toBe("repaired");
  });

  it("surfaces a non-zero exit with stderr in the error", async () => {
    await fakeCli(`process.stdin.resume(); process.stdin.on("end", () => { console.error("boom"); process.exit(3); });`);
    await expect(
      structuredCall({ system: "sys", user: "usr", schema, schemaName: "t" }),
    ).rejects.toThrow(/exited 3.*boom/s);
  });
});
