# PR Review Agent — Design

Date: 2026-07-06
Status: Approved (schema, memory, storage, and context-selection choices confirmed by user)

## Problem

Manual PR review is slow and inconsistent across a team. Diff-only LLM reviewers miss
project-wide context (conventions, existing helpers, callers of changed code), so their
findings are shallow or wrong. This tool reviews PRs with an LLM **plus a persistent,
incrementally-updated map of the whole repository**, so findings account for the code
around the diff — while keeping token cost bounded.

## Goals

1. CLI that reviews a local git diff or a GitHub PR and outputs structured findings
   (terminal report + JSON file).
2. GitHub Action that posts findings as inline PR review comments (changed lines only)
   and fails the check only above a configurable severity threshold.
3. Repo "memory": a codemap of every file (symbols + LLM summary) stored in the repo,
   updated incrementally after merges, used to inject relevant context into reviews.
4. Config file (`.pr-review.yml`) for threshold, ignored paths, custom instructions.
5. Vitest tests for diff parsing and finding formatting (LLM mocked).

## Non-goals

- Multi-provider LLM support (Anthropic only; model configurable via env).
- Embeddings/vector retrieval (import graph does context selection).
- Reviewing generated/vendored code (excluded by default ignore patterns).

## Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │                 CLI (commander)              │
                 │  pr-review index | review | comment          │
                 └──────┬───────────────────────┬───────────────┘
                        │                       │
              ┌─────────▼────────┐    ┌─────────▼──────────┐
              │  Codemap module  │    │    Diff module      │
              │  (memory system) │    │ local git / PR diff │
              └─────────┬────────┘    └─────────┬──────────┘
                        │  neighbor context      │ parsed hunks
                        └──────────┬─────────────┘
                                   ▼
                        ┌─────────────────────┐
                        │  Review engine      │
                        │  prompt build +     │
                        │  Anthropic call     │
                        │  (forced tool-use   │
                        │   → typed findings) │
                        └──────────┬──────────┘
                                   ▼
                 ┌───────────┬─────────────┬──────────────┐
                 │ CLI report│ JSON output │ GitHub review │
                 │ (pretty)  │ (file)      │ (octokit)     │
                 └───────────┴─────────────┴──────────────┘
```

## Components

### 1. Diff module (`src/diff/`)

- `parse.ts` — parses unified diff text into `FileDiff[]`: path, status
  (added/modified/deleted/renamed), hunks with old/new line ranges, and the set of
  **new-file line numbers that are added/changed** (needed both for prompting and for
  validating that PR comments land on commentable lines).
- `local.ts` — produces a diff from a local repo: `git diff <base>...HEAD` (default base
  auto-detected: `origin/main`/`origin/master`/`main`), or `--staged`.
- `github.ts` — fetches a PR diff via octokit (`pulls.get` with diff media type).

### 2. Codemap module (`src/codemap/`) — the memory system

**Index shape** (`.pr-review/index.json`, committed to the consuming repo):

```json
{
  "version": 1,
  "generatedAt": "2026-07-06T...",
  "files": {
    "src/auth/session.ts": {
      "hash": "<sha1 of content>",
      "summary": "One-paragraph LLM summary of purpose and key behaviors.",
      "symbols": ["export function createSession(user: User): Session", "..."],
      "imports": ["src/auth/token.ts", "src/db/client.ts"]
    }
  }
}
```

- `indexer.ts` — per-file extraction:
  - TS/JS: TypeScript compiler API — exported symbols with signatures, plus resolved
    relative import paths.
  - Other languages: regex fallback (function/class/def names, import-ish lines).
- `summarize.ts` — LLM one-paragraph summary per file (batched, several files per
  call), only for files whose content hash changed since last index. `--no-llm` flag
  builds a symbols-only index (works without an API key).
- `graph.ts` — builds the import graph from the index; given the changed files of a
  diff, selects **direct importers + direct imports**, ranked (importers first — they
  break when the diff is wrong), and packs summaries + symbols into a configurable
  token budget (default ~8k tokens of context, estimated at 4 chars/token).
- `store.ts` — load/save index; staleness = content hash mismatch; deleted files pruned.

**Incremental update:** `pr-review index` re-processes only files whose hash changed
(or all with `--full`). Post-merge workflow runs it on push to main and auto-commits
the index, so the memory tracks the repo as PRs land.

### 3. Review engine (`src/llm/`, `src/review.ts`)

- `client.ts` — Anthropic SDK. Model from `PR_REVIEW_MODEL` env var (default a current
  Sonnet-class model); key from `ANTHROPIC_API_KEY`.
- Structured output via **forced tool use**: a single `report_findings` tool whose
  input schema is the findings array. No JSON-parsing-from-prose fragility.
- `prompt.ts` — system prompt (reviewer persona, categories, severity rubric, "comment
  only on changed lines", custom instructions from config) + user message (repo
  context block from codemap, then the diff with explicit new-file line numbers).
- Large diffs: files reviewed in chunks if the packed prompt would exceed a size
  limit; findings merged.

**Finding schema** (zod, `src/llm/schema.ts`):

```ts
{
  file: string,
  start_line: number,   // new-file line numbers
  end_line: number,
  severity: "critical" | "high" | "medium" | "low" | "info",
  category: "bug" | "security" | "missing-tests" | "naming" | "complexity" | "custom",
  confidence: number,   // 0..1
  title: string,
  body: string,         // markdown
  suggestion?: string   // replacement code for the exact line range
}
```

Post-validation: findings on files/lines not in the diff are dropped (logged in
verbose mode); confidence below config minimum dropped.

### 4. Output (`src/report/`)

- `cli.ts` — grouped-by-file terminal report with severity colors and summary counts.
- `json.ts` — full run output `{ meta, findings[] }` written to `--json <path>`
  (default `pr-review-report.json`).
- Exit code: 1 if any finding at/above `fail_on` threshold (default `high`), else 0.

### 5. GitHub integration (`src/github/comments.ts`)

- Creates **one PR review** (octokit `pulls.createReview`) containing all inline
  comments — single notification, not comment spam.
- Comments use `line`/`start_line` + `side: RIGHT`; findings whose range isn't in the
  diff fall back to the review body summary.
- `suggestion` renders as a ```suggestion``` block when the range is commentable.
- Marker comment (`<!-- pr-review-agent -->`) — previous reviews by the agent are
  dismissed/superseded to avoid stale duplicates on force-push.

### 6. GitHub Action (`action.yml`, composite)

Inputs: `anthropic-api-key` (required), `github-token` (default `${{ github.token }}`),
`model`, `fail-on`, `config-path`, `post-comments` (default true).
Steps: setup-node → `npm ci`/`npx` the CLI → `pr-review review --pr $PR --post` →
exit code gates the check. A second documented workflow
(`examples/update-index.yml`) runs `pr-review index` on push to main and
auto-commits `.pr-review/index.json`.

### 7. Config (`src/config.ts`, `.pr-review.yml`)

```yaml
fail_on: high            # check fails at/above this severity
min_confidence: 0.5
ignore:
  - "dist/**"
  - "**/*.gen.ts"
context_token_budget: 8000
custom_instructions: |
  Flag missing JSDoc on exported functions.
categories:              # optional: disable categories
  naming: false
```

Loaded from repo root, zod-validated, deep-merged over defaults. CLI flags override.

## Error handling

- Missing API key: clear error naming the env var; `index --no-llm` still works.
- LLM/tool-use output failing zod validation: one retry with the validation error
  appended; then fail with a readable message.
- Missing/stale index: review still runs (diff-only) with a warning suggesting
  `pr-review index`.
- GitHub API failures posting comments: report still printed/saved; nonzero exit.

## Testing (Vitest)

- `diff/parse` — fixture diffs: multi-file, renames, deletes, no-newline-at-EOF,
  changed-line-set extraction.
- `codemap/graph` — neighbor selection and token-budget packing on a synthetic index.
- `llm/schema` — validation, drop rules (out-of-diff lines, low confidence).
- `report` — formatting and exit-code threshold logic.
- `config` — defaults, merge, bad YAML errors.
- Anthropic client mocked via `vi.mock`; no network in tests.

## Build order (per user)

1. Core CLI end-to-end against a real local git diff (index + review + report/JSON).
2. GitHub Action + PR comment posting.
3. Config file support + tests as final pass.
4. README (problem, setup, Mermaid architecture diagram, screenshot placeholder).
