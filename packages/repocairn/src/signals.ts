import path from "node:path";
import ts from "typescript";
import { TS_EXTENSIONS } from "./indexer.js";

export type SignalKind = "hook" | "error-handling" | "control-flow";

export interface Signal {
  file: string;
  line: number;
  kind: SignalKind;
  detail: string;
}

// Curated v1 list — React/Vue-style hooks and classic lifecycle methods only.
// Other ecosystems' hook idioms are a scope call, not a technical one; extend here when needed.
const HOOK_NAMES = new Set([
  "useEffect",
  "useLayoutEffect",
  "useState",
  "useMemo",
  "useCallback",
  "useRef",
  "useContext",
  "useReducer",
  "useImperativeHandle",
  "componentDidMount",
  "componentDidUpdate",
  "componentWillUnmount",
  "watch",
  "connect",
]);

const CONTROL_FLOW_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.ReturnStatement,
]);

/**
 * Deterministic, pre-LLM detection of hooks / error-handling / control-flow
 * touching added lines only — v1 has no old-file content to diff against, so
 * it can't distinguish "added" from "removed" and doesn't try to.
 */
export function detectSignals(filePath: string, content: string, changedLines: Iterable<number>): Signal[] {
  const ext = path.extname(filePath).toLowerCase();
  if (!TS_EXTENSIONS.has(ext)) return [];

  const changed = new Set(changedLines);
  if (changed.size === 0) return [];

  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  } catch {
    return [];
  }

  const signals: Signal[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node) => {
    const line = lineOf(node);
    if (changed.has(line)) {
      if (ts.isTryStatement(node)) {
        const empty = node.catchClause?.block.statements.length === 0;
        signals.push({
          file: filePath,
          line,
          kind: "error-handling",
          detail: empty ? "empty catch block" : "try/catch",
        });
      } else if (CONTROL_FLOW_KINDS.has(node.kind)) {
        signals.push({ file: filePath, line, kind: "control-flow", detail: ts.SyntaxKind[node.kind] });
      } else if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : null;
        if (name && HOOK_NAMES.has(name)) {
          signals.push({ file: filePath, line, kind: "hook", detail: name });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return signals;
}
