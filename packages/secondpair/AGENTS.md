# secondpair — agent reference

LLM-powered PR review CLI. "The second pair of eyes." Reviews a diff
(local, or a GitHub/GitLab/Bitbucket PR), posts inline comments, gates CI
on severity. Sibling package `codengram` supplies whole-repo context (a
persistent codemap) so review isn't diff-blind.

Package root: `packages/secondpair`. Entry points: `src/cli.ts` (bin:
`secondpair` / `pr-review`), `src/index.ts` (library exports).

## Pipeline (in call order)

```
CLI (cli.ts)
  → get diff (diff/github.ts | diff/local.ts | gitlab/comments.ts | bitbucket/comments.ts)
  → load previous state: report/json.ts (loadPreviousIds/loadPreviousFindings from pr-review-report.json)
                          suppressions.ts (.pr-review-suppressions.yml)
                          suppress-signals.ts (won't-fix replies/reactions on prior PR comments)
  → runReview()  [review.ts] — THE core pipeline:
      1. redact.ts: strip secrets from diff text (built-in + config patterns)
      2. diff/parse.ts: parseDiff() → FileDiff[], filter ignored/deleted/no-op files
      3. codengram: loadIndex + selectContext (+ inline snippets) → repo context, then redact it too
      4. chunkFiles() by token budget → 1+ structuredCall() per chunk (llm/prompt.ts prompts)
      5. llm/schema.ts validateFindings() — drop findings outside diff lines / below min_confidence / disabled category
      6. capFindings() — enforce per-file/total limits, lowest-confidence dropped first
      7. dedupeById() — collapse same-fingerprint findings from ONE LLM response (keeps higher confidence)
      8. optional self_critique second LLM pass (CRITIQUE_SYSTEM_PROMPT) — drop-only, never adds
      9. reconcile.ts reconcileFindings() — classify vs previousIds/previousFindings/suppressedIds
         → { active (all current, for CI gate), toPost (subset that's actually new) }
  → report/cli.ts formatReport() (terminal) + shouldFail() (CI gate)
  → report/json.ts writeJsonReport() → pr-review-report.json
  → if --post: github/comments.ts postReview() | gitlab/comments.ts postGlReview() | bitbucket/comments.ts postBbReview()
      each: re-fetch LIVE existing comment ids right before posting (final dedupe net,
      independent of steps 7-9 above), post only what's not already there, resolve
      threads/discussions for reconciliation.resolved ids (Bitbucket: no-op, API can't)
```

## Key files

| File | Purpose |
|---|---|
| `src/review.ts` | `runReview()` — the whole pipeline above. `dedupeById()`, `capFindings()` exported for testing. |
| `src/finding-id.ts` | Fingerprinting. `fingerprintFinding()` = sha1(`file\|category\|sorted-significant-title-tokens`), **excludes line numbers on purpose** (survives code drift). `findingsSoftMatch()` catches reworded titles: same file+category, lines within 3, Jaccard≥0.3 or ≥2 shared tokens. |
| `src/reconcile.ts` | `reconcileFindings()` — new/persistent/resolved/suppressed classification against prior state. |
| `src/llm/prompt.ts` | System prompts (`REVIEW_SYSTEM_PROMPT`, `CRITIQUE_SYSTEM_PROMPT`) and user-prompt builders. Diff + context are concatenated raw — **no prompt-injection framing** (known gap, see `docs/architecture-review.md`). |
| `src/llm/schema.ts` | Zod schemas for LLM output + `validateFindings()` (diff/confidence/category filtering). |
| `src/diff/parse.ts` | Unified-diff parser → `FileDiff[]`. New-file line numbers only (the commentable side). |
| `src/redact.ts` | Regex-only secret redaction (AWS/GitHub/generic secret/PEM + configurable patterns). No entropy fallback. |
| `src/suppressions.ts` / `src/suppress-signals.ts` | Persisted ignore list (`.pr-review-suppressions.yml`) + detection of "won't fix"/reaction replies on the agent's own PR comments. |
| `src/github/comments.ts`, `src/gitlab/comments.ts`, `src/bitbucket/comments.ts` | Per-platform posting. All three independently re-check live `existingIds` before posting — treat this pattern as load-bearing, don't remove it even though `reconcile.ts` already filtered. |
| `src/config.ts` | `ReviewConfig` Zod schema + `loadConfig()`/`mergeConfig()` (`.pr-review.yml`) + `isIgnored()`. |
| `src/report/cli.ts` | Terminal formatting + `shouldFail(findings, fail_on)` — CI gate, operates on `active` findings (not just `toPost`), i.e. persistent findings still count. |
| `src/report/json.ts` | `pr-review-report.json` read/write — this file IS the cross-run dedupe state when `--post` isn't used. If CI doesn't cache it, every run without `--post` looks "all new" locally (doesn't cause duplicate posts, just loses local persistent/new distinction). |

## Key types (`src/types.ts`)

- `Finding`: `{ file, start_line, end_line, severity, category, confidence, title, body, suggestion?, id? }`. `id` set post-validation via `withFindingId()`.
- `Severity`: critical > high > medium > low > info (in that rank order, index 0 = most severe).
- `Category`: bug | security | missing-tests | naming | complexity | custom.
- `ReviewResult`: `{ findings (=active), summary, dropped, reconciliation?, findingsToPost? }`.
- `RunStats`: counts at every drop stage (`droppedValidation`, `droppedCaps`, `droppedDuplicates`, `droppedCritique`, `suppressed`, `persistent`) — use these to debug "why didn't my finding show up."

## CLI

```
secondpair index [--full] [--no-llm] [--dir] [--config]     # build/update .codengram/index.json
secondpair review [--staged] [--base <ref>] [--pr <n>] [--repo <slug>]
                   [--host github|gitlab|bitbucket] [--post] [--fail-on <severity>]
                   [--no-context] [--json <path>] [--suppressions <path>] [--write-suppressions]
```
Host auto-detected from CI env vars if `--host` omitted (`BITBUCKET_*` → bitbucket, `GITLAB_CI` → gitlab, else github). Without `--pr`/CI env, reviews local diff (branch-vs-base or `--staged`).

## Invariants an agent editing this code must preserve

1. **Never post from `active`/`findings` directly — always post `toPost`/`findingsToPost`.** `active` includes persistent findings already on the PR.
2. Any new dedup logic goes in `review.ts` *before* `reconcileFindings()`, or in the platform `post*Review()` *live-recheck* — not just in `reconcile.ts`, which only sees one run's worth of state.
3. `fingerprintFinding()` must stay line-number-free. If you need line info in the id, that's a design change (breaks drift-tolerance) — flag it, don't silently add.
4. Redaction (`redact.ts`) runs on diff text AND injected repo context, before either reaches `structuredCall`. Keep both call sites if you touch `review.ts`.
5. Bitbucket's `resolveBbCommentsForIds` is intentionally a documented no-op (Cloud API has no thread-resolve endpoint) — not a bug, don't "fix" it into a silent failure.
6. Tests mock `codengram`'s `structuredCall`/`getModel` (see any `test/*.test.ts` top of file) — never let a test hit a real LLM API.

## Known gaps (see `docs/architecture-review.md` for full detail)

- No prompt-injection mitigation (diff content is untrusted in external-PR workflows).
- No lock/concurrency-safety for two CI runs racing on the same PR (needs a CI-level `concurrency:` group, not fixable in-package).
- Bitbucket posting path has no test proving its dedupe-skip works (GitHub and GitLab do).
- No ceiling on total LLM calls for very large diffs (cost risk).
