import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGhRepoSlug, resolveGhToken } from "../src/github/auth.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveGhToken", () => {
  it("reads GITHUB_TOKEN from the environment", () => {
    vi.stubEnv("GITHUB_TOKEN", "tok-123");
    expect(resolveGhToken()).toBe("tok-123");
  });

  it("throws when no token is set", () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(() => resolveGhToken()).toThrow(/GITHUB_TOKEN/);
  });
});

describe("resolveGhRepoSlug", () => {
  it("prefers the explicit flag over the env var", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "env/repo");
    expect(resolveGhRepoSlug("flag/repo")).toBe("flag/repo");
  });

  it("falls back to GITHUB_REPOSITORY", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/api");
    expect(resolveGhRepoSlug(undefined)).toBe("acme/api");
  });

  it("throws when neither is set", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "");
    expect(() => resolveGhRepoSlug(undefined)).toThrow(/GITHUB_REPOSITORY/);
  });
});
