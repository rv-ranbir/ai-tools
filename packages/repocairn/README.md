# repocairn

**Persistent, token-efficient repository memory for AI tools.**

`repocairn` builds a compact index of every file in a repo — exported symbols, resolved import graph, and a one-paragraph LLM summary per file — and keeps it current incrementally (only changed files are re-indexed). Any AI tool can then query that memory instead of re-reading the codebase: as an **MCP server**, a **CLI**, or a **TypeScript library**.

The index lives at `.repocairn/index.json`, committed to the repo: transparent, versioned with the code, shared by local runs, CI, and every tool on the team.

## Quick start

```bash
npm install -g repocairn   # or: npm i -D repocairn

# One-shot onboarding: config + git hooks + first index (llm off by default)
repocairn init

# Optional: enable LLM summaries in package.json#repocairn or .repocairn.yml (`llm: true`)
# then: repocairn index --llm
```

`init` writes `package.json#repocairn` (or `.repocairn.yml` with `--yml`), installs **pre-commit** / **pre-push** hooks that re-index only the files you touch, and builds `.repocairn/index.json`. Commit the index so agents and CI can read it. repocairn itself has **no CI integration** — hooks keep the brain fresh locally.

Manual updates anytime: `repocairn index` (respects config `llm` / `ignore`; `--llm` / `--no-llm` override).

## Using graphify as the extraction source

If [graphify](https://github.com/safishamsi/graphify) has already built `graphify-out/graph.json` for the repo, `repocairn index` uses it instead of running its own tree-sitter/regex extraction: graphify's AST layer resolves cross-file dependencies (including monorepo workspace packages via `package.json`/`pnpm-workspace.yaml`) across far more languages than repocairn's own extractors, at zero LLM cost. repocairn reads the `file_type: "code"` nodes and treats `imports`/`imports_from`/`calls`/`indirect_call`/`implements`/`inherits`/`mixes_in`/`embeds`/`references`/`re_exports` edges between different files as dependencies — bare workspace-package imports (`import { X } from "some-pkg"`) resolve to `calls`/`indirect_call` edges rather than `imports_from`, so both are needed to catch monorepo cross-package coupling. LLM summaries are still repocairn's own, generated and cached independently.

No graph present → repocairn falls back to its own extractors below, unchanged. Nothing to configure — detected automatically per run.

## MCP server — plug the memory into any AI assistant

```bash
# Claude Code
claude mcp add repocairn -- repocairn mcp

# Cursor / Windsurf / any MCP client (.mcp.json / mcp.json)
{
  "mcpServers": {
    "repocairn": { "command": "repocairn", "args": ["mcp"] }
  }
}
```

Tools exposed:

| Tool | What it answers |
|---|---|
| `get_context` | "What depends on these files?" — token-budgeted summaries + symbols of importers, imports, and the files themselves |
| `search_symbols` | "Where is X?" — substring search over exported symbols and paths |
| `file_info` | "Tell me about this file" — summary, symbols, imports, and importers |

## Config

Precedence: `.repocairn.yml` → `package.json#repocairn` → defaults.

```yaml
# .repocairn.yml
hooks:
  pre-commit: true
  pre-push: true
llm: false          # default — no API key needed for hooks
ignore: []
```

## CLI

```bash
repocairn init [--yml] [--no-hooks] [--no-index] [--force]
repocairn hook pre-commit|pre-push                      # used by git hooks
repocairn index [--full] [--llm|--no-llm] [--ignore <glob>]...
repocairn context src/auth.ts src/db.ts --budget 8000   # context for a change
repocairn query login                                   # symbol/path search
repocairn query src/auth.ts --file                      # one file's full record
repocairn setup                                         # wire MCP into AI tools
repocairn mcp                                           # stdio MCP server
```

## Library

```ts
import { runIndex, loadIndex, selectContext, searchSymbols } from "repocairn";

await runIndex({ cwd, llm: true });
const index = await loadIndex(cwd);
const { rendered } = selectContext(index!, ["src/auth.ts"], 8000);
```

`selectContext` is deterministic — no LLM call. For each changed file the import graph yields its **importers** first (the code that breaks if the change is wrong), then its imports, ranked by how many changed files they touch, packed into the token budget.

## Providers

Anthropic is the default (schema-constrained output via the official SDK). Any OpenAI-compatible endpoint also works:

| Provider | Env vars |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY` (model defaults to `claude-opus-4-8`; override with `REPOCAIRN_MODEL`) |
| OpenRouter | `OPENROUTER_API_KEY` + `REPOCAIRN_MODEL` |
| OpenAI | `OPENAI_API_KEY` + `REPOCAIRN_MODEL` |
| Any OpenAI-compatible endpoint | `REPOCAIRN_BASE_URL` + `REPOCAIRN_API_KEY` + `REPOCAIRN_MODEL` |

Force a provider with `REPOCAIRN_PROVIDER=anthropic|openai|openrouter|openai-compatible`. `PR_REVIEW_*` spellings are accepted as aliases.

## Staying in sync after code changes

Not automatic-on-every-save, and not a full rebuild each time — it's git-triggered and hash-incremental:

- **When it regenerates**: the `pre-commit` hook (installed by `repocairn init`) re-indexes exactly the files you `git add`, on every commit. `pre-push` catches anything that slipped through (e.g. `git commit --no-verify`) by diffing the commits about to be pushed. No hook, no daemon, no polling — if you never commit, the index never moves. Manual trigger anytime: `repocairn index`.
- **How it knows what changed**: each file's sha1 content hash is stored in `.repocairn/index.json`. On update, only files whose hash differs from what's stored (or that are new) get re-extracted and re-summarized (`planIndexUpdate` in `src/indexer.ts`). Files deleted from disk are pruned from the index. Untouched files are copied over as-is — **not** re-read, re-parsed, or re-summarized.
- **Why it's cheap**: symbol/import extraction (AST via TS compiler API or tree-sitter) is fast and free — it's the LLM summary call per file that costs money/time, and that's exactly what hash-skipping avoids re-paying for. A 1-line commit touching 1 file does 1 file's worth of work, not the whole repo's, regardless of repo size.
- **Full rebuild**: `repocairn index --full` (or `init --force`) ignores hashes and re-does every file — use after upgrading repocairn itself (extraction logic changed) or if the index looks corrupted, not for routine use.

## Index format

Per file: content hash (sha1), exported symbol signatures, resolved imports (language-dependent, see below), and a one-paragraph LLM summary. Re-runs re-extract and re-summarize **only files whose hash changed**; deleted files are pruned. Keys are sorted for stable git diffs.

### Language support

| Language | Symbols | Imports resolved | Notes |
|---|---|---|---|
| TypeScript / JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) | ✅ real AST (TS compiler API) | ✅ full relative-import resolution | Also drives `.vue`/`.svelte` via their `<script>` block |
| Python (`.py`) | ✅ tree-sitter AST | ✅ dotted module paths (`from a.b import`, relative levels) | |
| C / C++ (`.c .h .cpp .hpp`) | ✅ tree-sitter AST | ✅ literal `#include "x.h"` (same-dir or repo-root) | Doesn't follow compiler `-I` search paths, doesn't descend into `#ifdef`/`#if` blocks, angle-bracket `<system.h>` includes skipped |
| PHP (`.php`) | ✅ tree-sitter AST | ✅ literal `require`/`require_once`/`include`/`include_once` with a plain string arg | `use Foo\Bar;` (PSR-4 autoload) not resolved — needs `composer.json` awareness; `__DIR__ . '/x.php'` concatenations skipped |
| Go, Rust, Java, Kotlin, C#, Scala | ✅ tree-sitter AST | ❌ symbols only | Import specs are module/package paths (`go.mod`, crate tree, classpath, `.csproj`, sbt/mvn source roots), not file paths — resolving them needs build-manifest awareness repocairn doesn't have yet |
| Ruby (`.rb`) | ✅ tree-sitter AST | ❌ symbols only | `require`/`require_relative` not resolved yet (known gap — `require_relative` is a literal relative path and would be a cheap follow-up) |
| Elixir (`.ex .exs`) | ✅ tree-sitter AST | ❌ symbols only | `defmodule`/`def`/`defp` inside nested `do...end` blocks; module names aren't file-path-mapped (compiled via `mix`), so no import graph |
| Bash (`.sh`) | ✅ tree-sitter AST | ✅ literal `source`/`.` with a plain path arg | Only top-level `function foo(){}` definitions and `source`/`.` references produce output — arbitrary command invocations (the bulk of a script) are intentionally ignored |
| Objective-C (`.m`) | ✅ tree-sitter AST | ✅ literal `#import "x.h"` (same-dir or repo-root) | `.h` headers stay routed through the C config (shared extension) — ObjC-only header syntax (`@interface` in a header) isn't picked up there, a known miss |
| Zig (`.zig`) | ✅ tree-sitter AST | ✅ literal `@import("x.zig")` (bare package names like `@import("std")` never resolve on disk, which is correct) | Function declarations only — top-level `const`/`struct` aren't distinguished from an `@import` assignment without inspecting the value, not attempted yet |
| Swift (`.swift`), Dart (`.dart`) | ⚠️ regex fallback only | ⚠️ regex best-effort | No usable tree-sitter build: `tree-sitter-swift.wasm` corrupts the shared WASM heap on real-world source under the pinned runtime (confirmed on real repos); `tree-sitter-dart.wasm` is built for a newer language ABI the pinned runtime rejects outright and the modern runtime also can't load (dylink metadata error) |
| Lua (`.lua`) | ⚠️ regex fallback only | ⚠️ regex best-effort | `tree-sitter-lua.wasm` only parses correctly when it's the *first* grammar loaded in the process — loading any other grammar first (order otherwise irrelevant) makes every later Lua parse silently return an empty tree, no error thrown. Unusable in a real multi-language repo |
| Anything else | ⚠️ regex fallback | ⚠️ regex best-effort | Line-pattern heuristics (`def`/`class`/`func`/`import`/`require`/etc.), same-dir/repo-root resolution |

Symbols-only languages still feed the index and `get_context`/`search_symbols` — they just don't contribute import-graph edges (no importer/imports ranking in `selectContext` for those files' cross-references).

Built as the memory layer of [secondpair](../..), which reviews PRs with whole-repo context from this index.

## License

MIT
