import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatBbCommentBody,
  formatBbSummaryBody,
  resolveBbAuthHeader,
  resolveBbRef,
} from "../src/bitbucket/comments.js";
import { AGENT_MARKER } from "../src/github/comments.js";
import type { Finding } from "../src/types.js";

const BB_ENV_VARS = [
  "BITBUCKET_TOKEN",
  "BITBUCKET_ACCESS_TOKEN",
  "BITBUCKET_USERNAME",
  "BITBUCKET_APP_PASSWORD",
  "BITBUCKET_WORKSPACE",
  "BITBUCKET_REPO_SLUG",
  "BITBUCKET_PR_ID",
];

function withEnv(env: Record<string, string>) {
  for (const key of BB_ENV_VARS) vi.stubEnv(key, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

const finding: Finding = {
  file: "src/a.ts",
  start_line: 10,
  end_line: 12,
  severity: "high",
  category: "bug",
  confidence: 0.9,
  title: "Off-by-one in loop bound",
  body: "The loop reads past the end.",
  suggestion: "for (let i = 0; i < xs.length; i++) total += xs[i];",
};

describe("resolveBbRef", () => {
  it("resolves from Bitbucket Pipelines env vars", () => {
    withEnv({ BITBUCKET_WORKSPACE: "acme", BITBUCKET_REPO_SLUG: "api", BITBUCKET_PR_ID: "7" });
    expect(resolveBbRef(undefined, undefined)).toEqual({
      workspace: "acme",
      repoSlug: "api",
      prId: 7,
    });
  });

  it("prefers explicit flags over env", () => {
    withEnv({ BITBUCKET_WORKSPACE: "acme", BITBUCKET_REPO_SLUG: "api", BITBUCKET_PR_ID: "7" });
    expect(resolveBbRef("other/repo", 42)).toEqual({
      workspace: "other",
      repoSlug: "repo",
      prId: 42,
    });
  });

  it("throws a helpful error when the PR cannot be identified", () => {
    withEnv({});
    expect(() => resolveBbRef(undefined, undefined)).toThrow(/workspace\/repo_slug/);
  });
});

describe("resolveBbAuthHeader", () => {
  it("uses a Bearer token when BITBUCKET_TOKEN is set", () => {
    withEnv({ BITBUCKET_TOKEN: "tok-123" });
    expect(resolveBbAuthHeader()).toBe("Bearer tok-123");
  });

  it("uses Basic auth for username + app password", () => {
    withEnv({ BITBUCKET_USERNAME: "alice", BITBUCKET_APP_PASSWORD: "pw" });
    expect(resolveBbAuthHeader()).toBe(`Basic ${Buffer.from("alice:pw").toString("base64")}`);
  });

  it("throws when no credentials are available", () => {
    withEnv({});
    expect(() => resolveBbAuthHeader()).toThrow(/BITBUCKET_TOKEN/);
  });
});

describe("Bitbucket comment formatting", () => {
  it("renders severity, category, title, body and the dedupe marker", () => {
    const body = formatBbCommentBody(finding);
    expect(body).toContain("**HIGH**");
    expect(body).toContain("`bug`");
    expect(body).toContain("Off-by-one in loop bound");
    expect(body).toContain(AGENT_MARKER);
  });

  it("renders suggestions as a plain code fence (no GitHub suggestion block)", () => {
    const body = formatBbCommentBody(finding);
    expect(body).toContain("Suggested fix:");
    expect(body).toContain("```\nfor (let i = 0;");
    expect(body).not.toContain("```suggestion");
  });

  it("summary carries counts and the failure notice", () => {
    const body = formatBbSummaryBody(
      { summary: "One problem.", findings: [finding], dropped: [] },
      true,
    );
    expect(body).toContain("1 high");
    expect(body).toContain("Check failed");
    expect(body).toContain(AGENT_MARKER);
  });
});
