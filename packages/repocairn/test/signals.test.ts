import { describe, expect, it } from "vitest";
import { detectSignals } from "../src/signals.js";

describe("detectSignals", () => {
  it("returns [] for an unsupported extension without throwing", () => {
    expect(detectSignals("src/main.rs", "fn main() {}", [1])).toEqual([]);
  });

  it("returns [] when no lines are marked as changed", () => {
    const content = `try {\n  risky();\n} catch (e) {}\n`;
    expect(detectSignals("src/a.ts", content, [])).toEqual([]);
  });

  it("detects a try/catch touching a changed line, flagging an empty catch block", () => {
    const content = `function f() {\n  try {\n    risky();\n  } catch (e) {}\n}\n`;
    const signals = detectSignals("src/a.ts", content, [2]);
    expect(signals).toEqual([{ file: "src/a.ts", line: 2, kind: "error-handling", detail: "empty catch block" }]);
  });

  it("detects a non-empty catch block as plain try/catch", () => {
    const content = `function f() {\n  try {\n    risky();\n  } catch (e) {\n    log(e);\n  }\n}\n`;
    const signals = detectSignals("src/a.ts", content, [2]);
    expect(signals).toEqual([{ file: "src/a.ts", line: 2, kind: "error-handling", detail: "try/catch" }]);
  });

  it("detects control-flow statements (if/for/while/switch/return) on changed lines", () => {
    const content = `function f(x) {\n  if (x) {\n    return 1;\n  }\n  for (const y of x) {}\n}\n`;
    const signals = detectSignals("src/a.ts", content, [2, 3, 5]);
    expect(signals).toEqual([
      { file: "src/a.ts", line: 2, kind: "control-flow", detail: "IfStatement" },
      { file: "src/a.ts", line: 3, kind: "control-flow", detail: "ReturnStatement" },
      { file: "src/a.ts", line: 5, kind: "control-flow", detail: "ForOfStatement" },
    ]);
  });

  it("detects a curated React hook call on a changed line", () => {
    const content = `function Comp() {\n  useEffect(() => {\n    sub();\n  }, []);\n}\n`;
    const signals = detectSignals("src/comp.tsx", content, [2]);
    expect(signals).toEqual([{ file: "src/comp.tsx", line: 2, kind: "hook", detail: "useEffect" }]);
  });

  it("ignores an arbitrary call that isn't in the curated hook list", () => {
    const content = `function f() {\n  doSomething();\n}\n`;
    expect(detectSignals("src/a.ts", content, [2])).toEqual([]);
  });

  it("scopes to changed lines only — a control-flow statement on an unchanged line is not reported", () => {
    const content = `function f(x) {\n  if (x) {\n    return 1;\n  }\n}\n`;
    expect(detectSignals("src/a.ts", content, [4])).toEqual([]);
  });
});
