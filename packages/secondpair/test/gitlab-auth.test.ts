import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGlRef } from "../src/gitlab/auth.js";

const GL_ENV = ["GITLAB_TOKEN", "GL_TOKEN", "CI_SERVER_URL", "CI_PROJECT_ID", "CI_MERGE_REQUEST_IID"];

function withEnv(env: Record<string, string>) {
  for (const key of GL_ENV) vi.stubEnv(key, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveGlRef", () => {
  it("resolves from GitLab CI env vars", () => {
    withEnv({
      CI_SERVER_URL: "https://gitlab.example.com/",
      CI_PROJECT_ID: "42",
      CI_MERGE_REQUEST_IID: "7",
    });
    expect(resolveGlRef(undefined, undefined)).toEqual({
      serverUrl: "https://gitlab.example.com",
      projectId: "42",
      mrIid: 7,
    });
  });

  it("prefers flags and encodes project path", () => {
    withEnv({});
    expect(resolveGlRef("group/project", 3)).toEqual({
      serverUrl: "https://gitlab.com",
      projectId: "group%2Fproject",
      mrIid: 3,
    });
  });

  it("throws when MR cannot be identified", () => {
    withEnv({});
    expect(() => resolveGlRef(undefined, undefined)).toThrow(/group\/project/);
  });
});
