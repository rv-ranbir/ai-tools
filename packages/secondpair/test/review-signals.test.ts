import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

vi.mock("repocairn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("repocairn")>()),
  structuredCall: vi.fn(),
  getModel: () => "mock-model",
}));

import { structuredCall } from "repocairn";
import { runReview } from "../src/review.js";

const mockedCall = vi.mocked(structuredCall);

let dir: string;

beforeEach(async () => {
  mockedCall.mockReset();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-review-signals-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,5 @@
 function f() {
+  try {
+    risky();
+  } catch (e) {}
 }
`;

describe("signal_detector wiring", () => {
  it("injects a SIGNALS section into the prompt when enabled and a signal fires", async () => {
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "a.ts"), "function f() {\n  try {\n    risky();\n  } catch (e) {}\n}\n");

    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    await runReview({
      cwd: dir,
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, signal_detector: true },
      changeDescription: "t",
      useContext: false,
    });

    const user = mockedCall.mock.calls[0][0].user as string;
    expect(user).toContain("# SIGNALS");
    expect(user).toContain("src/a.ts:2 [error-handling] empty catch block");
  });

  it("omits the SIGNALS section when signal_detector is disabled", async () => {
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "a.ts"), "function f() {\n  try {\n    risky();\n  } catch (e) {}\n}\n");

    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    await runReview({
      cwd: dir,
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, signal_detector: false },
      changeDescription: "t",
      useContext: false,
    });

    const user = mockedCall.mock.calls[0][0].user as string;
    expect(user).not.toContain("# SIGNALS");
  });

  it("omits the SIGNALS section when the file can't be read from disk (no crash)", async () => {
    // Deliberately no file written to `dir` — collectSignals' readFile fails and is swallowed.
    mockedCall.mockResolvedValue({ summary: "s", findings: [] });

    const result = await runReview({
      cwd: dir,
      diffText: DIFF,
      config: { ...DEFAULT_CONFIG, signal_detector: true, parallel_agents: false },
      changeDescription: "t",
      useContext: false,
    });

    expect(result.summary).toBe("s");
    const user = mockedCall.mock.calls[0][0].user as string;
    expect(user).not.toContain("# SIGNALS");
  });
});
