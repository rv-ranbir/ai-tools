import { createRequire } from "node:module";
import path from "node:path";
import Parser from "web-tree-sitter";
import { existsSync } from "node:fs";
import { dedupe, resolveGenericImport } from "./indexer.js";
import type { CodemapFileEntry } from "./types.js";

const require = createRequire(import.meta.url);

// Ruby's grammar needs an external-scanner (dylink) build that the pinned 0.20.8
// runtime above can't load; only Ruby uses this newer loader + wasm source.
// Loaded via require (not a static import) because the aliased package's .d.ts
// declares `declare module 'web-tree-sitter'` (its original name, not the
// alias), which TS won't auto-match to the "web-tree-sitter-modern" specifier.
// Note the modern (0.26.x) API split Language out as its own top-level export
// instead of a Parser.Language namespace member (0.20.8's shape) — typed
// separately below rather than reusing `typeof Parser` for both.
// Deliberate: two coexisting tree-sitter runtimes is real complexity for one
// language — collapse to one once web-tree-sitter's dylink support is the
// only thing every grammar in tree-sitter-wasms is actually built against.
const modernModule = require("web-tree-sitter-modern") as {
  Parser: typeof Parser;
  Language: typeof Parser.Language;
};
const ModernParser = modernModule.Parser;
const ModernLanguage = modernModule.Language;

/**
 * Per-language AST shape needed to pull imports + top-level symbols.
 * Only covers direct children of the file root (plus one level of
 * namespace/module unwrapping) — matches the "exported-ish surface" the
 * regex fallback aimed for, not a full symbol table.
 */
interface LanguageConfig {
  wasmName: string;
  /** Peel decorator/wrapper nodes (e.g. Python's decorated_definition) to the real definition. */
  unwrap?: (node: Parser.SyntaxNode) => Parser.SyntaxNode;
  /** Container node types (namespace/module blocks) whose direct body children are treated as top-level too. */
  containerNodeTypes?: Set<string>;
  importNodeTypes: Set<string>;
  extractImportSpecs: (node: Parser.SyntaxNode) => string[];
  /**
   * How to turn a raw import spec into a repo-relative path. Defaults to
   * resolveGenericImport (dotted module paths: `pkg.sub` -> `pkg/sub`, with
   * guessed extension suffixes) — wrong for languages whose specs are
   * already literal file paths with a real extension (C/C++ #include, PHP
   * require/include), which use resolveLiteralImport instead.
   */
  resolveImport?: (cwd: string, fromFile: string, spec: string) => string | null;
  /** node type -> label prefixed onto the symbol name (e.g. "def foo"). */
  symbolNodeTypes: Record<string, string>;
}

const IDENT_TYPES = new Set([
  "identifier",
  "field_identifier",
  "simple_identifier",
  "type_identifier",
  "namespace_identifier",
  "constant",
  "name", // PHP grammar's node type for identifiers (class/function names)
  "word", // Bash grammar's node type for a function's name
]);

/**
 * Find the declared name for a definition node, independent of grammar quirks:
 * follows `name`/`declarator` fields (handles C's pointer/function declarator
 * chains) and falls back to the first identifier-shaped child (handles
 * Kotlin, whose function/class nodes don't expose a `name` field at all).
 */
function symbolName(node: Parser.SyntaxNode): string | null {
  let n: Parser.SyntaxNode | null = node;
  for (let i = 0; i < 4 && n; i++) {
    if (IDENT_TYPES.has(n.type)) return n.text;
    n = n.childForFieldName("name") ?? n.childForFieldName("declarator");
  }
  const direct = node.namedChildren.find((c) => c && IDENT_TYPES.has(c.type));
  return direct?.text ?? null;
}

function pythonImportSpecs(node: Parser.SyntaxNode): string[] {
  if (node.type === "import_from_statement") {
    const mod = node.childForFieldName("module_name");
    return mod ? [mod.text] : [];
  }
  // import_statement: `import a.b`, `import a as b`, `import a, b`
  const specs: string[] = [];
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "dotted_name") specs.push(child.text);
    else if (child.type === "aliased_import") {
      const name = child.childForFieldName("name");
      if (name) specs.push(name.text);
    }
  }
  return specs;
}

/** `#include "path.h"` / `#include "../util.h"` — literal relative file paths, no dot-splitting. */
function cIncludeSpecs(node: Parser.SyntaxNode): string[] {
  const pathNode = node.childForFieldName("path");
  if (!pathNode || pathNode.type !== "string_literal") return []; // angle-bracket <system> includes are string_literal's sibling type; skip
  return [pathNode.text.replace(/^"|"$/g, "")];
}

/**
 * For specs that are already literal relative file paths with a real
 * extension (`uv.h`, `../util.h`, `other.php`) — unlike resolveGenericImport,
 * does NOT dot-split or guess extension suffixes (that logic exists for
 * Python's `pkg.sub` module paths and mangles a filename like "uv.h" into
 * "uv/h" before the existence check, silently dropping every C/C++/PHP
 * import). Tries the importing file's own directory, then the repo root.
 */
function resolveLiteralImport(cwd: string, fromFile: string, spec: string): string | null {
  const baseDir = path.dirname(fromFile).replace(/\\/g, "/");
  for (const base of [baseDir, "."]) {
    const rel = path.posix.normalize(path.posix.join(base, spec));
    if (existsSync(path.join(cwd, rel))) return rel;
  }
  return null;
}

const NO_IMPORTS = { importNodeTypes: new Set<string>(), extractImportSpecs: () => [] };

/** `source ./lib.sh` / `. ../other.sh` — the only bash "commands" that name a real file. */
function bashSourceSpecs(node: Parser.SyntaxNode): string[] {
  const name = node.childForFieldName("name")?.text;
  if (name !== "source" && name !== ".") return [];
  const arg = node.childForFieldName("argument");
  return arg ? [arg.text.replace(/^["']|["']$/g, "")] : [];
}

/** `const x = @import("util.zig")` — literal relative path only; bare package names (`@import("std")`) never resolve on disk. */
function zigImportSpecs(node: Parser.SyntaxNode): string[] {
  const call = node.namedChildren.find((c) => c && c.type === "builtin_function");
  const ident = call?.namedChildren.find((c) => c && c.type === "builtin_identifier");
  if (!call || ident?.text !== "@import") return [];
  const args = call.namedChildren.find((c) => c && c.type === "arguments");
  const str = args?.namedChildren.find((c) => c && c.type === "string");
  return str ? [str.text.slice(1, -1)] : [];
}

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  ".py": {
    wasmName: "tree-sitter-python",
    unwrap: (n) =>
      n.type === "decorated_definition" ? (n.childForFieldName("definition") ?? n) : n,
    importNodeTypes: new Set(["import_statement", "import_from_statement"]),
    extractImportSpecs: pythonImportSpecs,
    symbolNodeTypes: { function_definition: "def", class_definition: "class" },
  },
  // Go/Java/Kotlin/Rust/C# imports are module- or package-path references, not
  // file paths — resolving them correctly needs go.mod / source-root / crate
  // mod-tree / csproj awareness we don't have yet. Symbols only for now.
  // Add a manifest-aware resolver per language when a repo actually needs
  // cross-file context there; see README "Language support" table.
  ".go": {
    wasmName: "tree-sitter-go",
    unwrap: (n) => (n.type === "type_declaration" ? (n.namedChild(0) ?? n) : n),
    ...NO_IMPORTS,
    symbolNodeTypes: { function_declaration: "func", method_declaration: "method", type_spec: "type" },
  },
  ".rs": {
    wasmName: "tree-sitter-rust",
    ...NO_IMPORTS,
    symbolNodeTypes: {
      function_item: "fn",
      struct_item: "struct",
      trait_item: "trait",
      enum_item: "enum",
    },
  },
  ".java": {
    wasmName: "tree-sitter-java",
    ...NO_IMPORTS,
    symbolNodeTypes: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      record_declaration: "record",
    },
  },
  ".kt": {
    wasmName: "tree-sitter-kotlin",
    ...NO_IMPORTS,
    symbolNodeTypes: { function_declaration: "fun", class_declaration: "class" },
  },
  ".cs": {
    wasmName: "tree-sitter-c_sharp",
    containerNodeTypes: new Set(["namespace_declaration"]),
    ...NO_IMPORTS,
    symbolNodeTypes: { class_declaration: "class", interface_declaration: "interface" },
  },
  // PHP: `use Foo\Bar;` is PSR-4/autoload-based (no composer.json awareness yet,
  // so not resolved), but require/include ARE literal file paths — handled.
  ".php": {
    wasmName: "tree-sitter-php",
    // require/include calls are wrapped in an expression_statement; peel it to
    // check the actual require/include node underneath.
    unwrap: (n) => (n.type === "expression_statement" ? (n.namedChild(0) ?? n) : n),
    importNodeTypes: new Set(["require_once_expression", "require_expression", "include_expression", "include_once_expression"]),
    extractImportSpecs: (node) => {
      // "string" = single-quoted ('x.php'), "encapsed_string" = double-quoted ("x.php") in this grammar.
      const arg = node.namedChildren.find((c) => c && (c.type === "string" || c.type === "encapsed_string"));
      // best-effort: only plain string literals resolve; `__DIR__ . '/x.php'` concatenations are skipped.
      return arg ? [arg.text.replace(/^['"]|['"]$/g, "")] : [];
    },
    resolveImport: resolveLiteralImport,
    symbolNodeTypes: { function_definition: "function", class_declaration: "class", interface_declaration: "interface" },
  },
  // No Swift entry: tree-sitter-wasms' tree-sitter-swift.wasm crashes the
  // process under the pinned 0.20.8 runtime on real (non-trivial) source —
  // confirmed via a real-repo run: even a single small file corrupts the
  // shared wasm heap, so subsequent unrelated-language parses in the same
  // process degrade and eventually OOM. The modern (0.26.11) runtime can't
  // load this wasm at all (dylink-format build, same class of incompatibility
  // Ruby/Vue hit) and no alternative swift.wasm source is bundled anywhere we
  // use. Falls back to the regex extractGenericFacts, same as before this
  // language's tree-sitter support was attempted — not a regression.
  ".c": {
    wasmName: "tree-sitter-c",
    importNodeTypes: new Set(["preproc_include"]),
    extractImportSpecs: cIncludeSpecs,
    resolveImport: resolveLiteralImport,
    symbolNodeTypes: { function_definition: "func", struct_specifier: "struct" },
  },
  ".cpp": {
    wasmName: "tree-sitter-cpp",
    containerNodeTypes: new Set(["namespace_definition"]),
    importNodeTypes: new Set(["preproc_include"]),
    resolveImport: resolveLiteralImport,
    extractImportSpecs: cIncludeSpecs,
    symbolNodeTypes: { function_definition: "func", class_specifier: "class", struct_specifier: "struct" },
  },
  // Scala's import paths are package-qualified like Java's, not file paths —
  // same "needs build-manifest awareness" gap as the Go/Java/Kotlin/Rust/C#
  // group above. Symbols only.
  ".scala": {
    wasmName: "tree-sitter-scala",
    ...NO_IMPORTS,
    symbolNodeTypes: {
      object_definition: "object",
      class_definition: "class",
      trait_definition: "trait",
      function_definition: "def",
      function_declaration: "def",
    },
  },
  // Only top-level `function foo() {}` / `foo() {}` definitions and
  // `source`/`.` file references — arbitrary command invocations (the bulk of
  // a shell script) intentionally produce neither a symbol nor an import.
  ".sh": {
    wasmName: "tree-sitter-bash",
    importNodeTypes: new Set(["command"]),
    extractImportSpecs: bashSourceSpecs,
    resolveImport: resolveLiteralImport,
    symbolNodeTypes: { function_definition: "function" },
  },
  // Objective-C implementation files only (`.m`) — `.h` headers stay routed
  // through the C config above (shared extension; ObjC-specific @interface
  // syntax there falls back to the regex extractor, a known miss).
  ".m": {
    wasmName: "tree-sitter-objc",
    importNodeTypes: new Set(["preproc_include"]),
    extractImportSpecs: cIncludeSpecs,
    resolveImport: resolveLiteralImport,
    symbolNodeTypes: { class_interface: "interface", class_implementation: "implementation" },
  },
  // Struct/const top-level declarations not captured (Zig's `const x = ...`
  // node type is indistinguishable from an `@import` assignment without
  // inspecting the value, same class of gap as Lua's assigned requires) —
  // function declarations are the high-value surface, covered.
  ".zig": {
    wasmName: "tree-sitter-zig",
    importNodeTypes: new Set(["variable_declaration"]),
    extractImportSpecs: zigImportSpecs,
    resolveImport: resolveLiteralImport,
    symbolNodeTypes: { function_declaration: "fn" },
  },
};
LANGUAGE_CONFIGS[".h"] = LANGUAGE_CONFIGS[".c"];
LANGUAGE_CONFIGS[".hpp"] = LANGUAGE_CONFIGS[".cpp"];

// Dart is not addable from the bundled tree-sitter-wasms grammar: its wasm is
// built for language ABI version 15, outside the pinned 0.20.8 runtime's
// 13-14 range, and fails differently (dylink metadata parse error) under the
// modern 0.26.11 runtime too — same "no working build available to us" class
// as Swift below. Falls back to the regex extractGenericFacts.
//
// Lua hits the same class of problem in a nastier form: tree-sitter-wasms'
// tree-sitter-lua.wasm loads and parses *correctly* under the pinned runtime
// only when it's the very first grammar loaded in the process. Confirmed via
// isolated repro: loading literally any other grammar first (bash, Python,
// Go — new or pre-existing, order doesn't matter) makes every subsequent Lua
// parse silently return an empty tree, no error thrown. The modern runtime
// rejects the same wasm outright (dylink metadata error, like Dart). Since a
// real repo indexes multiple languages per run, "only works if loaded first"
// is not usable — falls back to the regex extractGenericFacts.

const RUBY_CONFIG: LanguageConfig = {
  wasmName: "", // loaded via the modern loader/wasm source instead, see loadRubyLanguage
  ...NO_IMPORTS,
  symbolNodeTypes: { method: "def", class: "class", module: "module" },
};

// Elixir's grammar has no dedicated node types for module/function
// definitions — `defmodule`, `def`, `defp`, `import`, `alias`, `require` are
// all just `call` nodes distinguished only by their `target` identifier text.
// That doesn't fit the type-keyed LanguageConfig contract above (which
// dispatches on node.type), so it gets its own walk, not a config entry —
// see extractElixirFacts. Module names aren't file-path-mapped (compiled via
// mix, not 1:1 with source files), so symbols only, same as the JVM group.
function elixirCallTarget(node: Parser.SyntaxNode): string | null {
  return node.type === "call" ? (node.childForFieldName("target")?.text ?? null) : null;
}

function elixirDefName(node: Parser.SyntaxNode): string | null {
  const args = node.namedChildren.find((c) => c && c.type === "arguments");
  const first = args?.namedChildren[0];
  if (!first) return null;
  if (first.type === "call") return first.childForFieldName("target")?.text ?? null;
  if (IDENT_TYPES.has(first.type)) return first.text;
  return null;
}

function walkElixir(nodes: (Parser.SyntaxNode | null)[], symbols: string[]): void {
  for (const node of nodes) {
    if (!node) continue;
    const target = elixirCallTarget(node);
    if (target === "defmodule") {
      const args = node.namedChildren.find((c) => c && c.type === "arguments");
      const alias = args?.namedChildren.find((c) => c && c.type === "alias");
      if (alias) symbols.push(`defmodule ${alias.text}`);
      const doBlock = node.namedChildren.find((c) => c && c.type === "do_block");
      if (doBlock) walkElixir(doBlock.namedChildren, symbols);
    } else if (target === "def" || target === "defp") {
      const name = elixirDefName(node);
      if (name) symbols.push(`${target} ${name}`);
    }
  }
}

export function hasTreeSitterSupport(ext: string): boolean {
  return ext in LANGUAGE_CONFIGS || ext === ".rb" || ext === ".ex" || ext === ".exs";
}

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

const languageCache = new Map<string, Promise<Parser.Language>>();
function loadLanguage(wasmName: string): Promise<Parser.Language> {
  let cached = languageCache.get(wasmName);
  if (!cached) {
    cached = ensureInit().then(() =>
      Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${wasmName}.wasm`)),
    );
    languageCache.set(wasmName, cached);
  }
  return cached;
}

// A fresh `new Parser()` per file leaks: this pinned runtime's Parser.delete()
// doesn't fully release its wasm-side allocation, so per-file instances pile
// up until the process OOMs (confirmed on a 500-file real repo — flat memory
// once the parser is reused instead of recreated). One parser per language,
// reused across every file of that language; only the per-file Tree is deleted.
const parserCache = new Map<string, Parser>();
async function getParser(wasmName: string): Promise<Parser> {
  let parser = parserCache.get(wasmName);
  if (!parser) {
    const language = await loadLanguage(wasmName);
    parser = new Parser();
    parser.setLanguage(language);
    parserCache.set(wasmName, parser);
  }
  return parser;
}

let modernInitPromise: Promise<void> | null = null;
let rubyLanguagePromise: Promise<InstanceType<typeof ModernLanguage>> | null = null;
// Same reuse-not-recreate rule as the pinned runtime's parserCache above.
let rubyParser: InstanceType<typeof ModernParser> | null = null;
function loadRubyLanguage() {
  if (!modernInitPromise) modernInitPromise = ModernParser.init();
  const init = modernInitPromise;
  if (!rubyLanguagePromise) {
    rubyLanguagePromise = init.then(() =>
      ModernLanguage.load(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm")),
    );
  }
  return rubyLanguagePromise;
}

/** One level of namespace/module flattening: container bodies count as top-level too. */
function topLevelNodes(root: Parser.SyntaxNode, config: LanguageConfig): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  for (const raw of root.namedChildren) {
    if (!raw) continue;
    if (config.containerNodeTypes?.has(raw.type)) {
      const body = raw.childForFieldName("body");
      if (body) out.push(...body.namedChildren.filter((c): c is Parser.SyntaxNode => c !== null));
      continue;
    }
    out.push(raw);
  }
  return out;
}

function runExtraction(
  cwd: string,
  filePath: string,
  rootNode: { namedChildren: (Parser.SyntaxNode | null)[] },
  config: LanguageConfig,
): Pick<CodemapFileEntry, "symbols" | "imports"> {
  const symbols: string[] = [];
  const imports: string[] = [];
  const resolveImport = config.resolveImport ?? resolveGenericImport;
  for (const raw of topLevelNodes(rootNode as Parser.SyntaxNode, config)) {
    const node = config.unwrap ? config.unwrap(raw) : raw;
    if (config.importNodeTypes.has(node.type)) {
      for (const spec of config.extractImportSpecs(node)) {
        const resolved = resolveImport(cwd, filePath, spec);
        if (resolved) imports.push(resolved);
      }
      continue;
    }
    const label = config.symbolNodeTypes[node.type];
    if (label) {
      const name = symbolName(node);
      if (name) symbols.push(`${label} ${name}`);
    }
  }
  return { symbols: dedupe(symbols).slice(0, 80), imports: dedupe(imports) };
}

/** Extract symbols + resolved imports from one file via a real tree-sitter AST. */
export async function extractTreeSitterFacts(
  cwd: string,
  filePath: string,
  content: string,
): Promise<Pick<CodemapFileEntry, "symbols" | "imports">> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".rb") {
    let parser = rubyParser;
    if (!parser) {
      const language = await loadRubyLanguage();
      parser = new ModernParser();
      parser.setLanguage(language);
      rubyParser = parser;
    }
    const tree = parser.parse(content);
    try {
      if (!tree) return { symbols: [], imports: [] };
      return runExtraction(cwd, filePath, tree.rootNode, RUBY_CONFIG);
    } finally {
      tree?.delete();
    }
  }

  if (ext === ".ex" || ext === ".exs") {
    const parser = await getParser("tree-sitter-elixir");
    const tree = parser.parse(content);
    try {
      const symbols: string[] = [];
      walkElixir(tree.rootNode.namedChildren, symbols);
      return { symbols: dedupe(symbols).slice(0, 80), imports: [] };
    } finally {
      tree.delete();
    }
  }

  const config = LANGUAGE_CONFIGS[ext];
  if (!config) throw new Error(`no tree-sitter grammar configured for ${ext}`);
  const parser = await getParser(config.wasmName);
  const tree = parser.parse(content);
  try {
    return runExtraction(cwd, filePath, tree.rootNode, config);
  } finally {
    tree.delete();
  }
}
