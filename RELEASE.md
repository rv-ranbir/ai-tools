# Release guide

Two independent releases, do in this order: **`codengram` first** (`secondpair`
depends on it), then `secondpair`.

## 0. Before the first public commit

Repo identity is set: `LICENSE` and both `package.json` (`author`,
`repository`, `homepage`, `bugs`) point to `github.com/rv-ranbir/ai-tools`.
`YOUR_WORKSPACE` in `examples/bitbucket-pipelines.yml` is intentionally
left as a placeholder — that one's a user-fill-in example, not this repo's
own identity.

Checklist:
- [x] `LICENSE` added (MIT)
- [x] `repository`/`author`/`homepage`/`bugs`/`keywords` added to both `package.json`
- [x] `secondpair`'s `codengram` dependency pinned to `^0.1.0` (was `*` — fine inside the npm workspace, unresolvable for an outside installer)
- [x] Secrets scan: no real keys in tracked files (only redaction-test fixtures, obviously fake — `AKIAIOSFODNN7EXAMPLE` etc.); `.cursor-key` is gitignored and untracked
- [x] `.claude/settings.local.json` and `docs/superpowers/` untracked + gitignored (internal dev-process notes, not user-facing)
- [x] `npm run typecheck && npm test` — clean, 147 tests passing
- [ ] Decide npm scope: unscoped (`codengram`, `secondpair` — check name isn't taken) or scoped (`@you/codengram`)
- [ ] `npm whoami` — confirm logged into the right npm account
- [ ] Create the public GitHub repo, push
- [ ] Fill the "screenshot goes here" placeholder in root `README.md`

## 1. Publish to npm (the CLI/library "tool")

```bash
npm install
npm run build          # tsc -b, both packages → dist/
npm test

# codengram first — secondpair depends on it
cd packages/codengram
npm version patch      # or minor/major — bumps 0.1.0
npm publish --access public

cd ../secondpair
# bump the codengram dependency to match what you just published, if it moved
npm version patch
npm publish --access public
```

`files: ["dist"]` in both `package.json` means only `dist/` ships — no `src/`,
no tests, no docs bloat in the published tarball. Verify what actually gets
published before the real run:

```bash
npm pack --dry-run
```

After publish, anyone gets the CLI with:

```bash
npx codengram init
npx secondpair review --staged
```

## 2. Publish the GitHub Action

`action.yml` (root) already defines a composite/Docker action — that's the
CI-native release path, separate from npm. Once the repo is public:

1. Tag a release: `git tag v1 && git push origin v1` (or `v0.1.0` — Actions
   convention is a floating major tag like `v1` that you move forward).
2. GitHub → **Releases** → **Draft a new release** → pick the tag.
3. Check **"Publish this Action to the GitHub Marketplace"** (only shown
   once `action.yml` is present at repo root, which it is).
4. Pick a category (e.g. "Code review", "Continuous integration").
5. Publish.

Consumers then reference it as `uses: rv-ranbir/ai-tools@v1` in their
workflow — see `examples/pr-review.yml` for the consumer-side usage this
should match.

## 3. Publish as an MCP server (an "AI tool" for assistants)

`codengram` already ships an MCP server (`src/mcp.ts`, bin `codengram mcp`).
Once step 1 is done, any MCP client can add it without a local install:

```bash
claude mcp add codengram -- npx codengram mcp
```

This exposes `get_context`, `search_symbols`, `file_info` over the repo's
committed `.codengram/index.json` — already documented in root `README.md`
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
`secondpair`/`codengram` CLIs from step 1 — publish those first.

## Known non-blocking issue

`npm audit`: 9 vulnerabilities (1 critical) — all transitive **dev**
dependencies (`vitest`/`vite`/`esbuild`, the MCP SDK's `@hono/node-server`,
`postcss`). None are in the dependency tree of the published packages
(`files: ["dist"]` excludes them; they're monorepo-root devDependencies).
The critical one (`vitest`'s UI-server arbitrary file read) only applies if
someone runs `vitest --ui` with the UI server exposed — not used by any
script here. Fixable with `npm audit fix --force`, which bumps vitest to
v4 (breaking change, would need a test-suite re-run before trusting it) —
left for a deliberate follow-up, not bundled into this cleanup.
