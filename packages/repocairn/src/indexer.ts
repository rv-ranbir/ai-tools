import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { isIgnored } from "./ignore.js";
import { extractTreeSitterFacts, hasTreeSitterSupport } from "./tree-sitter-extract.js";
import type { CodemapFileEntry, CodemapIndex } from "./types.js";

const exec = promisify(execFile);

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TEXT_EXTENSIONS = new Set([
  ...TS_EXTENSIONS,
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".cs", ".php", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".vue", ".svelte",
]);

const MAX_FILE_BYTES = 400_000;

/** True when path has an indexable extension and is not ignored (file need not exist). */
export function isIndexableSourcePath(filePath: string, ignore: string[] = []): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && !isIgnored(filePath, ignore);
}

export function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/** List indexable source files via git (respects .gitignore), filtered by ignore globs. */
export async function listSourceFiles(cwd: string, ignore: string[] = []): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => isIndexableSourcePath(f, ignore));
}

export interface IndexUpdatePlan {
  /** Files whose content changed (or are new) and need re-extraction/re-summarizing. */
  stale: string[];
  /** Files present in the index but gone from disk. */
  removed: string[];
  /** File contents keyed by path (only for stale files). */
  contents: Map<string, string>;
}

export async function planIndexUpdate(
  cwd: string,
  files: string[],
  previous: CodemapIndex,
  full: boolean,
): Promise<IndexUpdatePlan> {
  const stale: string[] = [];
  const contents = new Map<string, string>();
  const onDisk = new Set(files);

  for (const file of files) {
    const abs = path.join(cwd, file);
    if (!existsSync(abs)) continue;
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) continue;
    const hash = sha1(content);
    if (full || previous.files[file]?.hash !== hash) {
      stale.push(file);
      contents.set(file, content);
    }
  }

  const removed = Object.keys(previous.files).filter((f) => !onDisk.has(f));
  return { stale, removed, contents };
}

/** Extract exported symbols and resolved relative imports from one file. */
export async function extractFileFacts(
  cwd: string,
  filePath: string,
  content: string,
): Promise<Pick<CodemapFileEntry, "symbols" | "imports">> {
  const ext = path.extname(filePath).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) {
    return extractTsFacts(cwd, filePath, content);
  }
  if (ext === ".vue" || ext === ".svelte") {
    // Template+embedded-script hybrids: the useful surface is the <script>
    // block, which is plain JS/TS — reuse the real TS AST path instead of a
    // template grammar we'd otherwise need just for this.
    const script = SCRIPT_BLOCK.exec(content)?.[1];
    return script ? extractTsFacts(cwd, filePath, script) : { symbols: [], imports: [] };
  }
  if (hasTreeSitterSupport(ext)) {
    return extractTreeSitterFacts(cwd, filePath, content);
  }
  return extractGenericFacts(cwd, filePath, content);
}

const SCRIPT_BLOCK = /<script[^>]*>([\s\S]*?)<\/script>/i;

function extractTsFacts(
  cwd: string,
  filePath: string,
  content: string,
): Pick<CodemapFileEntry, "symbols" | "imports"> {
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const symbols: string[] = [];
  const imports: string[] = [];

  const addImport = (spec: string) => {
    if (!spec.startsWith(".")) return; // only intra-repo imports feed the graph
    const resolved = resolveRelativeImport(cwd, filePath, spec);
    if (resolved) imports.push(resolved);
  };

  const signatureOf = (node: ts.Node): string => {
    const text = node.getText(source);
    const firstLine = text.split("\n")[0].replace(/\s*\{?\s*$/, "").trim();
    return firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
  };

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      addImport(stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        addImport(stmt.moduleSpecifier.text);
      }
      // `export { a, b as c }` and `export { a } from './y'` both name real
      // exports via exportClause — `export * from './y'` has none, only the
      // import edge above applies there.
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          symbols.push(`export { ${el.name.text} }`);
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      symbols.push(stmt.isExportEquals ? "export = default" : "export default");
    } else if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      if (isExported(stmt)) symbols.push(signatureOf(stmt));
      if (ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        symbols.push("export default");
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        symbols.push(`export const ${decl.name.getText(source)}`);
      }
    }
  }

  // CJS require assignments: const x = require('./y')
  for (const m of content.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    addImport(m[1]);
  }

  return { symbols: dedupe(symbols), imports: dedupe(imports) };
}

const GENERIC_SYMBOL = /^\s*(?:export\s+|public\s+|pub\s+)?(?:async\s+)?(def|class|func|fn|function|interface|struct|trait|module|type)\s+([A-Za-z_][A-Za-z0-9_]*)/;
// Note: unlike TS import specifiers, most non-JS languages (Python, Go, Java, Rust)
// resolve intra-repo modules WITHOUT a leading "./" — "from db import x" is the norm,
// not the exception. Do not require a leading dot/slash here; resolveGenericImport
// decides what's a real repo file, same job resolveRelativeImport does for TS.
const GENERIC_IMPORT =
  /^\s*(?:from\s+(\S+)\s+import|import\s+["']?([^\s"';]+)|require\s+["']([^"']+)["'])/;

function extractGenericFacts(
  cwd: string,
  filePath: string,
  content: string,
): Pick<CodemapFileEntry, "symbols" | "imports"> {
  const symbols: string[] = [];
  const imports: string[] = [];
  for (const line of content.split("\n")) {
    const sym = GENERIC_SYMBOL.exec(line);
    if (sym) symbols.push(`${sym[1]} ${sym[2]}`);
    const imp = GENERIC_IMPORT.exec(line);
    const spec = imp?.[1] ?? imp?.[2] ?? imp?.[3];
    if (spec) {
      const resolved = resolveGenericImport(cwd, filePath, spec);
      if (resolved) imports.push(resolved);
    }
  }
  return { symbols: dedupe(symbols).slice(0, 80), imports: dedupe(imports) };
}

/**
 * Best-effort resolution of a generic-language import spec to a repo-relative file.
 * Tries the importing file's own directory, then the repo root — covers flat
 * layouts and same-package sibling imports. Handles dotted package paths
 * (pkg.sub -> pkg/sub) and leading-dot relative levels (Python's `from .. import`).
 * Deliberately no src-layout / project-manifest awareness (pyproject.toml, go.mod) —
 * add when a repo actually needs it, on-disk sibling/root resolution covers the
 * common case cheaply.
 */
export function resolveGenericImport(cwd: string, fromFile: string, spec: string): string | null {
  const ext = path.extname(fromFile);
  const leadingDots = spec.match(/^\.+/)?.[0].length ?? 0;
  const asPath = spec.slice(leadingDots).replace(/\./g, "/");
  let baseDir = path.dirname(fromFile).replace(/\\/g, "/");
  for (let i = 1; i < leadingDots; i++) baseDir = path.posix.dirname(baseDir);
  const bases = leadingDots > 0 ? [baseDir] : [baseDir, "."];
  const suffixes = [ext, `/__init__${ext}`, `/index${ext}`];
  for (const base of bases) {
    for (const suf of suffixes) {
      const rel = path.posix.normalize(path.posix.join(base, asPath + suf));
      if (rel.startsWith("..")) continue; // stay inside the repo root
      if (existsSync(path.join(cwd, rel))) return rel;
    }
  }
  return null;
}

function resolveRelativeImport(cwd: string, fromFile: string, spec: string): string | null {
  const baseDir = path.dirname(fromFile);
  // "./foo.js" in TS ESM source usually means "./foo.ts"
  const candidates: string[] = [];
  const stripped = spec.replace(/\.(js|mjs|cjs)$/, "");
  for (const s of [spec, stripped]) {
    candidates.push(s);
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
      candidates.push(s + ext);
      candidates.push(path.posix.join(s, `index${ext}`));
    }
  }
  for (const cand of candidates) {
    const rel = path.posix.normalize(path.posix.join(baseDir.replace(/\\/g, "/"), cand));
    if (rel.startsWith("..")) continue; // stay inside the repo root
    if (existsSync(path.join(cwd, rel))) return rel;
  }
  return null;
}

export function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
