# repomind

**Persistent, token-efficient repository memory for AI tools.**

`repomind` builds a compact index of every file in a repo — exported symbols, resolved import graph, and a one-paragraph LLM summary per file — and keeps it current incrementally (only changed files are re-indexed). Any AI tool can then query that memory instead of re-reading the codebase: as an **MCP server**, a **CLI**, or a **TypeScript library**.

The index lives at `.repomind/index.json`, committed to the repo: transparent, versioned with the code, shared by local runs, CI, and every tool on the team.

## Quick start

```bash
npm install -g repomind
export ANTHROPIC_API_KEY=sk-ant-...   # any provider works; see Providers

repomind index            # build the memory (incremental afterwards)
repomind index --no-llm   # symbols + import graph only, no API key needed
```

## MCP server — plug the memory into any AI assistant

```bash
# Claude Code
claude mcp add repomind -- repomind mcp

# Cursor / Windsurf / any MCP client (.mcp.json / mcp.json)
{
  "mcpServers": {
    "repomind": { "command": "repomind", "args": ["mcp"] }
  }
}
```

Tools exposed:

| Tool | What it answers |
|---|---|
| `get_context` | "What depends on these files?" — token-budgeted summaries + symbols of importers, imports, and the files themselves |
| `search_symbols` | "Where is X?" — substring search over exported symbols and paths |
| `file_info` | "Tell me about this file" — summary, symbols, imports, and importers |

## CLI

```bash
repomind index [--full] [--no-llm] [--ignore <glob>]...
repomind context src/auth.ts src/db.ts --budget 8000   # context for a change
repomind query login                                   # symbol/path search
repomind query src/auth.ts --file                      # one file's full record
repomind mcp                                           # stdio MCP server
```

## Library

```ts
import { runIndex, loadIndex, selectContext, searchSymbols } from "repomind";

await runIndex({ cwd, llm: true });
const index = await loadIndex(cwd);
const { rendered } = selectContext(index!, ["src/auth.ts"], 8000);
```

`selectContext` is deterministic — no LLM call. For each changed file the import graph yields its **importers** first (the code that breaks if the change is wrong), then its imports, ranked by how many changed files they touch, packed into the token budget.

## Providers

Anthropic is the default (schema-constrained output via the official SDK). Any OpenAI-compatible endpoint also works:

| Provider | Env vars |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY` (model defaults to `claude-opus-4-8`; override with `REPOMIND_MODEL`) |
| OpenRouter | `OPENROUTER_API_KEY` + `REPOMIND_MODEL` |
| OpenAI | `OPENAI_API_KEY` + `REPOMIND_MODEL` |
| Any OpenAI-compatible endpoint | `REPOMIND_BASE_URL` + `REPOMIND_API_KEY` + `REPOMIND_MODEL` |

Force a provider with `REPOMIND_PROVIDER=anthropic|openai|openrouter|openai-compatible`. `PR_REVIEW_*` spellings are accepted as aliases.

## Index format

Per file: content hash (sha1), exported symbol signatures and resolved relative imports (TypeScript compiler API for TS/JS, regex heuristics for other languages), and a one-paragraph LLM summary. Re-runs re-extract and re-summarize **only files whose hash changed**; deleted files are pruned. Keys are sorted for stable git diffs.

Built as the memory layer of [pr-review-agent](../..), which reviews PRs with whole-repo context from this index.

## License

MIT
