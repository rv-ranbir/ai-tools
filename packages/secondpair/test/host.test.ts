import { afterEach, describe, expect, it, vi } from "vitest";
import { detectHost } from "../src/host.js";

const HOST_ENV_VARS = ["BITBUCKET_WORKSPACE", "BITBUCKET_PR_ID", "GITLAB_CI"];

function withEnv(env: Record<string, string>) {
  for (const key of HOST_ENV_VARS) vi.stubEnv(key, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("detectHost", () => {
  it("defaults to github with no CI env vars", () => {
    withEnv({});
    expect(detectHost(undefined)).toBe("github");
  });

  it("detects bitbucket from BITBUCKET_WORKSPACE", () => {
    withEnv({ BITBUCKET_WORKSPACE: "acme" });
    expect(detectHost(undefined)).toBe("bitbucket");
  });

  it("detects bitbucket from BITBUCKET_PR_ID", () => {
    withEnv({ BITBUCKET_PR_ID: "7" });
    expect(detectHost(undefined)).toBe("bitbucket");
  });

  it("detects gitlab from GITLAB_CI", () => {
    withEnv({ GITLAB_CI: "true" });
    expect(detectHost(undefined)).toBe("gitlab");
  });

  it("prefers an explicit flag over detection", () => {
    withEnv({ GITLAB_CI: "true" });
    expect(detectHost("github")).toBe("github");
  });

  it("throws on an invalid explicit host", () => {
    withEnv({});
    expect(() => detectHost("jenkins")).toThrow(/--host must be github, bitbucket, or gitlab/);
  });
});
