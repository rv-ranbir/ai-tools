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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "repocairn-generic-"));
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

describe("generic-language import resolution", () => {
  it("resolves Python's bare 'from X import Y' style (no leading dot)", async () => {
    await fs.writeFile(
      path.join(dir, "db.py"),
      'def fetch_all(conn):\n    return conn.execute("SELECT * FROM t").fetchall()\n',
    );
    await fs.writeFile(
      path.join(dir, "repository.py"),
      "from db import fetch_all\n\ndef get_users(conn):\n    return fetch_all(conn)\n",
    );
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);
    expect(index?.files["repository.py"]?.imports).toContain("db.py");
  });

  it("resolves leading-dot relative Python imports to a real file", async () => {
    await fs.mkdir(path.join(dir, "pkg"), { recursive: true });
    await fs.writeFile(path.join(dir, "pkg", "utils.py"), "def helper():\n    pass\n");
    await fs.writeFile(
      path.join(dir, "pkg", "service.py"),
      "from .utils import helper\n\ndef run():\n    return helper()\n",
    );
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);
    expect(index?.files["pkg/service.py"]?.imports).toContain("pkg/utils.py");
  });

  it("resolves dotted package paths (pkg.sub -> pkg/sub)", async () => {
    await fs.mkdir(path.join(dir, "pkg"), { recursive: true });
    await fs.writeFile(path.join(dir, "pkg", "sub.py"), "def helper():\n    pass\n");
    await fs.writeFile(
      path.join(dir, "main.py"),
      "from pkg.sub import helper\n\ndef run():\n    return helper()\n",
    );
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);
    expect(index?.files["main.py"]?.imports).toContain("pkg/sub.py");
  });

  it("does not fabricate an edge for an unresolvable (e.g. stdlib) import", async () => {
    await fs.writeFile(path.join(dir, "main.py"), "import os\n\ndef run():\n    return os.getcwd()\n");
    await commitAll();

    await runIndex({ cwd: dir, llm: false });
    const index = await loadIndex(dir);
    expect(index?.files["main.py"]?.imports).toEqual([]);
  });
});
