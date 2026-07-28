import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/index-command.js";
import { loadIndex } from "../src/store.js";

const exec = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "repocairn-lang-"));
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function commitAll() {
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-m", "commit"], { cwd: dir });
}

// One shared multi-language repo, indexed together: this is also the
// regression guard for a real bug found while adding these languages —
// tree-sitter-lua.wasm parses correctly only when it's the first grammar
// loaded in the process and silently returns empty trees once any other
// grammar has loaded first. Indexing several tree-sitter languages in one
// run is exactly the scenario that surfaced it, so keep them together here
// rather than in isolated single-language tests.
describe("newly added tree-sitter language support", () => {
  it("extracts symbols and imports across Scala, Bash, Objective-C, Zig and Elixir in one run", async () => {
    await fs.writeFile(
      path.join(dir, "Main.scala"),
      "object Main {\n  def run(): Unit = {}\n}\nclass Foo(x: Int) {\n  def bar(): Int = x\n}\ntrait Baz {\n  def qux(): Unit\n}\n",
    );
    await fs.writeFile(path.join(dir, "lib.sh"), "baz() { echo baz; }\n");
    await fs.writeFile(
      path.join(dir, "deploy.sh"),
      "function foo() {\n  echo hi\n}\n\nsource ./lib.sh\n",
    );
    await fs.writeFile(path.join(dir, "Foo.h"), "// header\n");
    await fs.writeFile(
      path.join(dir, "Foo.m"),
      '#import "Foo.h"\n\n@interface Foo : NSObject\n- (void)doThing;\n@end\n\n@implementation Foo\n- (void)doThing {\n}\n@end\n',
    );
    await fs.writeFile(path.join(dir, "util.zig"), "pub fn helper() void {}\n");
    await fs.writeFile(
      path.join(dir, "main.zig"),
      'const std = @import("std");\nconst util = @import("util.zig");\n\npub fn foo() void {}\n\nfn bar() i32 {\n  return 1;\n}\n',
    );
    await fs.writeFile(
      path.join(dir, "foo.ex"),
      "defmodule Foo.Bar do\n  def run(x) do\n    x + 1\n  end\n\n  defp helper() do\n    :ok\n  end\nend\n",
    );
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);
    const files = index!.files;

    expect(files["Main.scala"]?.symbols).toEqual(
      expect.arrayContaining(["object Main", "class Foo", "trait Baz"]),
    );
    expect(files["deploy.sh"]?.symbols).toContain("function foo");
    expect(files["deploy.sh"]?.imports).toContain("lib.sh");
    expect(files["lib.sh"]?.symbols).toContain("function baz");
    expect(files["Foo.m"]?.symbols).toEqual(
      expect.arrayContaining(["interface Foo", "implementation Foo"]),
    );
    expect(files["Foo.m"]?.imports).toContain("Foo.h");
    expect(files["main.zig"]?.symbols).toEqual(expect.arrayContaining(["fn foo", "fn bar"]));
    expect(files["main.zig"]?.imports).toContain("util.zig");
    expect(files["util.zig"]?.symbols).toContain("fn helper");
    expect(files["foo.ex"]?.symbols).toEqual(
      expect.arrayContaining(["defmodule Foo.Bar", "def run", "defp helper"]),
    );
  });

  it("falls back to the regex extractor for Lua (no reliable tree-sitter build)", async () => {
    await fs.writeFile(path.join(dir, "script.lua"), "function topLevel()\n  return 2\nend\n");
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);
    expect(index?.files["script.lua"]?.symbols).toContain("function topLevel");
  });
});
