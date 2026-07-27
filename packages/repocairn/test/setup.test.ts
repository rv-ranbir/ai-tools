import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup, TARGETS } from "../src/setup.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "repocairn-setup-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runSetup", () => {
  it("throws when nothing is detected and nothing forced", async () => {
    await expect(runSetup(dir)).rejects.toThrow(/No AI tool detected/);
  });

  it("throws on unknown target id", async () => {
    await expect(runSetup(dir, { targets: ["emacs"] })).rejects.toThrow(/Unknown target/);
  });

  it("wires Claude Code when .claude/ exists", async () => {
    await fs.mkdir(path.join(dir, ".claude"));
    const steps = await runSetup(dir);
    expect(steps).toHaveLength(3);

    const mcp = JSON.parse(await fs.readFile(path.join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.repocairn).toEqual({ command: "repocairn", args: ["mcp"] });
    expect(await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8")).toContain("repocairn:rule");
    expect(
      await fs.readFile(path.join(dir, ".claude", "skills", "repocairn", "SKILL.md"), "utf8"),
    ).toContain("name: repocairn");
  });

  it("is idempotent and preserves existing config", async () => {
    await fs.writeFile(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# My rules\n");
    const first = await runSetup(dir, { targets: ["claude"] });
    expect(first).toHaveLength(3);

    const second = await runSetup(dir, { targets: ["claude"] });
    expect(second).toHaveLength(0);

    const mcp = JSON.parse(await fs.readFile(path.join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    const claudeMd = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# My rules");
    expect(claudeMd.match(/repocairn:rule/g)).toHaveLength(1);
  });

  it("detects multiple tools at once", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# Agents\n");
    const steps = await runSetup(dir);
    expect(steps.some((s) => s.startsWith("Cursor:"))).toBe(true);
    expect(steps.some((s) => s.includes("AGENTS.md"))).toBe(true);
    expect(steps.some((s) => s.startsWith("Claude Code:"))).toBe(false);
  });

  it("uses the target's mcpServers key (copilot → servers)", async () => {
    const steps = await runSetup(dir, { targets: ["copilot"] });
    expect(steps.length).toBeGreaterThan(0);
    const mcp = JSON.parse(await fs.readFile(path.join(dir, ".vscode", "mcp.json"), "utf8"));
    expect(mcp.servers.repocairn).toBeDefined();
    expect(mcp.mcpServers).toBeUndefined();
  });

  it("writes frontmatter only when creating a fresh dedicated rule file", async () => {
    await runSetup(dir, { targets: ["cursor"] });
    const rule = await fs.readFile(path.join(dir, ".cursor", "rules", "repocairn.mdc"), "utf8");
    expect(rule.startsWith("---\n")).toBe(true);
    expect(rule).toContain("alwaysApply: true");
  });

  it("every target id is unique", () => {
    const ids = TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
