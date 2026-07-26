# codengram

**Persistent, token-efficient repository memory for AI tools.**

`codengram` builds a compact index of every file in a repo — exported symbols, resolved import graph, and a one-paragraph LLM summary per file — and keeps it current incrementally (only changed files are re-indexed). Any AI tool can then query that memory instead of re-reading the codebase: as an **MCP server**, a **CLI**, or a **TypeScript library**.

The index lives at `.codengram/index.json`, committed to the repo: transparent, versioned with the code, shared by local runs, CI, and every tool on the team.

## Quick start

```bash
npm install -g codengram   # or: npm i -D codengram

# One-shot onboarding: config + git hooks + first index (llm off by default)
codengram init

# Optional: enable LLM summaries in package.json#codengram or .codengram.yml (`llm: true`)
# then: codengram index --llm
```

`init` writes `package.json#codengram` (or `.codengram.yml` with `--yml`), installs **pre-commit** / **pre-push** hooks that re-index only the files you touch, and builds `.codengram/index.json`. Commit the index so agents and CI can read it. codengram itself has **no CI integration** — hooks keep the brain fresh locally.

Manual updates anytime: `codengram index` (respects config `llm` / `ignore`; `--llm` / `--no-llm` override).

## MCP server — plug the memory into any AI assistant

```bash
# Claude Code
claude mcp add codengram -- codengram mcp

# Cursor / Windsurf / any MCP client (.mcp.json / mcp.json)
{
  "mcpServers": {
    "codengram": { "command": "codengram", "args": ["mcp"] }
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

Precedence: `.codengram.yml` → `package.json#codengram` → defaults.

```yaml
# .codengram.yml
hooks:
  pre-commit: true
  pre-push: true
llm: false          # default — no API key needed for hooks
ignore: []
```

## CLI

```bash
codengram init [--yml] [--no-hooks] [--no-index] [--force]
codengram hook pre-commit|pre-push                      # used by git hooks
codengram index [--full] [--llm|--no-llm] [--ignore <glob>]...
codengram context src/auth.ts src/db.ts --budget 8000   # context for a change
codengram query login                                   # symbol/path search
codengram query src/auth.ts --file                      # one file's full record
codengram setup                                         # wire MCP into AI tools
codengram mcp                                           # stdio MCP server
```

## Library

```ts
import { runIndex, loadIndex, selectContext, searchSymbols } from "codengram";

await runIndex({ cwd, llm: true });
const index = await loadIndex(cwd);
const { rendered } = selectContext(index!, ["src/auth.ts"], 8000);
```

`selectContext` is deterministic — no LLM call. For each changed file the import graph yields its **importers** first (the code that breaks if the change is wrong), then its imports, ranked by how many changed files they touch, packed into the token budget.

## Providers

Anthropic is the default (schema-constrained output via the official SDK). Any OpenAI-compatible endpoint also works:

| Provider | Env vars |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY` (model defaults to `claude-opus-4-8`; override with `CODENGRAM_MODEL`) |
| OpenRouter | `OPENROUTER_API_KEY` + `CODENGRAM_MODEL` |
| OpenAI | `OPENAI_API_KEY` + `CODENGRAM_MODEL` |
| Any OpenAI-compatible endpoint | `CODENGRAM_BASE_URL` + `CODENGRAM_API_KEY` + `CODENGRAM_MODEL` |

Force a provider with `CODENGRAM_PROVIDER=anthropic|openai|openrouter|openai-compatible`. `PR_REVIEW_*` spellings are accepted as aliases.

## Staying in sync after code changes

Not automatic-on-every-save, and not a full rebuild each time — it's git-triggered and hash-incremental:

- **When it regenerates**: the `pre-commit` hook (installed by `codengram init`) re-indexes exactly the files you `git add`, on every commit. `pre-push` catches anything that slipped through (e.g. `git commit --no-verify`) by diffing the commits about to be pushed. No hook, no daemon, no polling — if you never commit, the index never moves. Manual trigger anytime: `codengram index`.
- **How it knows what changed**: each file's sha1 content hash is stored in `.codengram/index.json`. On update, only files whose hash differs from what's stored (or that are new) get re-extracted and re-summarized (`planIndexUpdate` in `src/indexer.ts`). Files deleted from disk are pruned from the index. Untouched files are copied over as-is — **not** re-read, re-parsed, or re-summarized.
- **Why it's cheap**: symbol/import extraction (AST via TS compiler API or tree-sitter) is fast and free — it's the LLM summary call per file that costs money/time, and that's exactly what hash-skipping avoids re-paying for. A 1-line commit touching 1 file does 1 file's worth of work, not the whole repo's, regardless of repo size.
- **Full rebuild**: `codengram index --full` (or `init --force`) ignores hashes and re-does every file — use after upgrading codengram itself (extraction logic changed) or if the index looks corrupted, not for routine use.

## Index format

Per file: content hash (sha1), exported symbol signatures, resolved imports (language-dependent, see below), and a one-paragraph LLM summary. Re-runs re-extract and re-summarize **only files whose hash changed**; deleted files are pruned. Keys are sorted for stable git diffs.

### Language support

| Language | Symbols | Imports resolved | Notes |
|---|---|---|---|
| TypeScript / JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) | ✅ real AST (TS compiler API) | ✅ full relative-import resolution | Also drives `.vue`/`.svelte` via their `<script>` block |
| Python (`.py`) | ✅ tree-sitter AST | ✅ dotted module paths (`from a.b import`, relative levels) | |
| C / C++ (`.c .h .cpp .hpp`) | ✅ tree-sitter AST | ✅ literal `#include "x.h"` (same-dir or repo-root) | Doesn't follow compiler `-I` search paths, doesn't descend into `#ifdef`/`#if` blocks, angle-bracket `<system.h>` includes skipped |
| PHP (`.php`) | ✅ tree-sitter AST | ✅ literal `require`/`require_once`/`include`/`include_once` with a plain string arg | `use Foo\Bar;` (PSR-4 autoload) not resolved — needs `composer.json` awareness; `__DIR__ . '/x.php'` concatenations skipped |
| Go, Rust, Java, Kotlin, C# | ✅ tree-sitter AST | ❌ symbols only | Import specs are module/package paths (`go.mod`, crate tree, classpath, `.csproj`), not file paths — resolving them needs build-manifest awareness codengram doesn't have yet |
| Ruby (`.rb`) | ✅ tree-sitter AST | ❌ symbols only | `require`/`require_relative` not resolved yet (known gap — `require_relative` is a literal relative path and would be a cheap follow-up) |
| Swift (`.swift`) | ⚠️ regex fallback only | ⚠️ regex best-effort | No tree-sitter support: the bundled `tree-sitter-swift.wasm` corrupts the shared WASM heap on real-world source under this package's runtime (confirmed on real repos — one file poisons memory for every later parse in the process, eventually OOMing), and no working alternative build is available |
| Anything else | ⚠️ regex fallback | ⚠️ regex best-effort | Line-pattern heuristics (`def`/`class`/`func`/`import`/`require`/etc.), same-dir/repo-root resolution |

Symbols-only languages still feed the index and `get_context`/`search_symbols` — they just don't contribute import-graph edges (no importer/imports ranking in `selectContext` for those files' cross-references).

Built as the memory layer of [secondpair](../..), which reviews PRs with whole-repo context from this index.

## License

MIT
