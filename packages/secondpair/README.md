# secondpair — the second pair of eyes

LLM-powered PR reviewer with whole-repo context. Reviews a diff (local,
staged, or a GitHub/GitLab/Bitbucket PR), posts inline comments, gates CI
on severity. Uses sibling package [`codengram`](../codengram/README.md) as
its repo memory so review isn't diff-blind — it sees callers, related
files, and project context, not just the patch.

## Install

```bash
npm install --save-dev secondpair
```

Needs an LLM API key (same resolution as `codengram` — set one):

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # default, recommended
# or: OPENAI_API_KEY / OPENROUTER_API_KEY / CODENGRAM_API_KEY+CODENGRAM_BASE_URL+CODENGRAM_MODEL
```

## Quick start

```bash
cd your-repo
npx codengram init          # one-time: builds repo memory, installs git hooks
npx secondpair review --staged           # review staged changes, print report
npx secondpair review --base main        # review branch vs main
```

Nothing to configure to get useful output — defaults are sane
(`fail_on: high`, `min_confidence: 0.5`). Add `.pr-review.yml` only when you
want to change them (see [Config](#config)).

## Reviewing a real PR (posting comments + CI gate)

Pick your platform, set its token, run with `--post`:

**GitHub** (GitHub Actions: `GITHUB_TOKEN` is provided automatically)
```bash
export GITHUB_TOKEN=ghp_...
npx secondpair review --pr 123 --repo owner/name --post --fail-on high
```

**GitLab** (in GitLab CI, `CI_SERVER_URL`/`CI_PROJECT_ID`/`CI_MERGE_REQUEST_IID`
are auto-detected; set a token as `GITLAB_TOKEN` or `GL_TOKEN`)
```bash
export GITLAB_TOKEN=glpat-...
npx secondpair review --post --fail-on high     # host auto-detected via GITLAB_CI env
```

**Bitbucket** (`BITBUCKET_WORKSPACE`/`BITBUCKET_PR_ID` auto-detected in
Bitbucket Pipelines; auth via token or app password)
```bash
export BITBUCKET_TOKEN=...                      # or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD
npx secondpair review --post --fail-on high
```

`--host` overrides auto-detection if you're running somewhere the CI env
vars aren't set. Exit code is 1 when any active finding is at/above
`fail_on` — wire that into your pipeline as the merge gate.

### Example: GitHub Actions

```yaml
- run: npx secondpair review --pr ${{ github.event.pull_request.number }} --repo ${{ github.repository }} --post
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Re-running on the same PR (new commit, or CI re-triggered) never
double-posts — each platform re-checks live existing comment ids right
before posting, on top of run-to-run fingerprint reconciliation.

## Config (`.pr-review.yml`, optional)

```yaml
fail_on: high              # critical|high|medium|low|info — CI exit-1 threshold
min_confidence: 0.5
ignore: ["**/*.generated.ts", "vendor/**"]
context_token_budget: 8000 # codengram context injected per chunk
context_snippets: 3
categories:                # turn any off
  bug: true
  security: true
  missing-tests: true
  naming: true
  complexity: true
  custom: true
limits:
  max_findings_per_file: 5
  max_total: 30
self_critique: false       # extra LLM pass that only drops findings, never adds
redact_secrets: true       # strip secrets from diff/context before they reach the LLM
redact_patterns: []        # extra regexes, on top of built-in AWS/GitHub-token/PEM/etc
write_suppressions: false  # persist "won't fix" replies to .pr-review-suppressions.yml
custom_instructions: ""
```

Suppress a finding permanently: reply "won't fix" (or react 👎) on its PR
comment, or hand-edit `.pr-review-suppressions.yml` with the finding id
from the report.

## `secondpair index`

Alias for `codengram index` — kept so a repo can adopt `secondpair` without
also depending on `codengram` directly for this one command. Same
incremental behavior; see [codengram's README](../codengram/README.md#staying-in-sync-after-code-changes)
for exactly when/how re-indexing happens and why it's cheap on repeated
runs — short version: git-hook-triggered, hash-incremental, never a full
rebuild unless you pass `--full`.

## More detail

- Agent-oriented internals reference (pipeline, invariants to preserve when
  editing): [`AGENTS.md`](./AGENTS.md)
- Architecture review, requirements scorecard, known gaps:
  [`docs/architecture-review.md`](./docs/architecture-review.md)
