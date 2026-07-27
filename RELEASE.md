# Release guide

`repocairn` and `secondpair` use synchronized versions. A semantic-version tag
starts the automated npm and GitHub release workflow.

## 0. Before the first public commit

Repo identity is set: `LICENSE` and both `package.json` (`author`,
`repository`, `homepage`, `bugs`) point to `github.com/rv-ranbir/ai-tools`.
`YOUR_WORKSPACE` in `examples/bitbucket-pipelines.yml` is intentionally
left as a placeholder — that one's a user-fill-in example, not this repo's
own identity.

Checklist:
- [x] `LICENSE` added (MIT)
- [x] `repository`/`author`/`homepage`/`bugs`/`keywords` added to both `package.json`
- [x] `secondpair`'s `repocairn` dependency pinned to the synchronized package version
- [x] Secrets scan: no real keys in tracked files (only redaction-test fixtures, obviously fake — `AKIAIOSFODNN7EXAMPLE` etc.); `.cursor-key` is gitignored and untracked
- [x] `.claude/settings.local.json` and `docs/superpowers/` untracked + gitignored (internal dev-process notes, not user-facing)
- [x] `npm run typecheck && npm test` — clean, 149 tests passing
- [ ] Decide npm scope: unscoped (`repocairn`, `secondpair` — check name isn't taken) or scoped (`@you/repocairn`)
- [ ] `npm whoami` — confirm logged into the right npm account
- [ ] Create the public GitHub repo, push
- [ ] Fill the "screenshot goes here" placeholder in root `README.md`
- [ ] Add an npm automation token as the repository Actions secret `NPM_TOKEN`

## 1. Automated npm and GitHub release

Prepare one reviewed change that:

1. Sets both package versions to the same semantic version.
2. Sets `secondpair`'s `repocairn` dependency to `^<that version>`.
3. Passes CI.

`npm run security` must pass with zero known vulnerabilities. It also proves
that `repocairn` and `secondpair` resolve as local workspace links.
`npm run security:consumers` packs both packages, installs the tarballs in
clean temporary projects with no consumer override, verifies that the bundled
MCP SDK resolves `@hono/node-server@2.0.12`, and requires each consumer's
`npm audit --json` total to be zero.

Push a matching tag such as `v1.2.3` or prerelease tag such as
`v1.2.3-beta.1`. The tag must point at the reviewed commit. Floating tags such
as `v1` do not trigger npm publishing.

The release workflow installs and validates dependencies without credentials,
checks all three versions/ranges, explicitly builds both packages, and uploads
the packed tarballs. A separate privileged job downloads only those tarballs,
publishes `repocairn` before `secondpair`, then creates the GitHub Release.
On retry, an existing npm version is skipped only when its registry SHA-1
matches the validated tarball; a mismatch aborts the synchronized release.
GitHub Releases that already exist are skipped.
Prereleases use npm's `next` dist-tag and GitHub's prerelease flag; stable
versions use npm's `latest` dist-tag.

Before pushing a tag, inspect the package payloads locally:

```bash
npm ci
npm run security
npm run build
npm run security:consumers
```

After publishing, users can run `npx repocairn init` and
`npx secondpair review --staged`.

## 2. Publish the GitHub Action to Marketplace

`action.yml` (root) already defines a composite/Docker action — that's the
CI-native release path. Marketplace's floating major tag is separate from the
immutable semantic tag that triggers npm publishing:

1. After a stable semantic release succeeds, move the matching major tag (for
   example `v1`) to that reviewed release commit and push it.
2. GitHub → **Releases** → open the semantic release.
3. Check **"Publish this Action to the GitHub Marketplace"** (only shown
   once `action.yml` is present at repo root, which it is).
4. Pick a category (e.g. "Code review", "Continuous integration").
5. Publish.

Consumers then reference it as `uses: rv-ranbir/ai-tools@v1` in their
workflow — see `examples/pr-review.yml` for the consumer-side usage this
should match.

## 3. Publish as an MCP server (an "AI tool" for assistants)

`repocairn` already ships an MCP server (`src/mcp.ts`, bin `repocairn mcp`).
Once step 1 is done, any MCP client can add it without a local install:

```bash
claude mcp add repocairn -- npx repocairn mcp
```

This exposes `get_context`, `search_symbols`, `file_info` over the repo's
committed `.repocairn/index.json` — already documented in root `README.md`
under "How the memory works". Optional extra reach: submit to a community
MCP registry (e.g. the `modelcontextprotocol/servers` list, or Smithery) by
following that registry's own PR/submission process — points at your
published npm package, no extra packaging needed on your side.

## 4. Package as a Claude Code Skill (the "AI skill")

A Skill is a markdown file with frontmatter (`name`, `description`) that
Claude Code discovers and can invoke by name. Two distribution shapes:

**A. Project-local skill** (ships inside a consuming repo, not published
anywhere) — drop a `SKILL.md` at `.claude/skills/secondpair/SKILL.md`:

```markdown
---
name: secondpair
description: Review the current diff or a PR with secondpair (LLM PR reviewer with whole-repo context). Use when the user asks to review code, review a PR, or check a diff for bugs.
---

Run `npx secondpair review --staged` for uncommitted work, or
`npx secondpair review --pr <n> --repo <owner/name> --post` for a real PR
(needs `GITHUB_TOKEN`/`GITLAB_TOKEN`/`BITBUCKET_TOKEN` — see README).
Summarize the findings table back to the user; do not silently fix findings
without asking.
```

That alone makes `/secondpair` (or natural-language "review this PR")
available to anyone with this repo checked out and `.claude/skills/`
picked up.

**B. Publishable plugin** (installable across repos, not just one checkout)
— needs a plugin manifest plus the same `SKILL.md` shape, published to a
plugin marketplace repo users add via `/plugin marketplace add`. The exact
manifest schema and marketplace-registration steps change with Claude Code
versions — check current docs before building this path, rather than
trusting a hardcoded schema here.

Either way, the skill is a thin wrapper that shells out to the npm-published
`secondpair`/`repocairn` CLIs from step 1 — publish those first.
