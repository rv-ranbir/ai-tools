import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBbAuthHeader, resolveBbRef } from "../src/bitbucket/auth.js";

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

afterEach(() => {
  vi.unstubAllEnvs();
});

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
