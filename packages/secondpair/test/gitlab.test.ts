import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MARKER } from "../src/github/comments.js";
import {
  getGlMrDiff,
  listGlWontFixFindingIds,
  postGlReview,
  resolveGlDiscussionsForIds,
} from "../src/gitlab/comments.js";
import { resolveGlRef } from "../src/gitlab/auth.js";
import type { Finding, ReviewResult } from "../src/types.js";

const GL_ENV = ["GITLAB_TOKEN", "GL_TOKEN", "CI_SERVER_URL", "CI_PROJECT_ID", "CI_MERGE_REQUEST_IID"];

function withEnv(env: Record<string, string>) {
  for (const key of GL_ENV) vi.stubEnv(key, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getGlMrDiff", () => {
  it("reconstructs a unified diff from /changes", async () => {
    withEnv({ GITLAB_TOKEN: "tok" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        diff_refs: { base_sha: "b", head_sha: "h", start_sha: "s" },
        changes: [
          {
            old_path: "a.ts",
            new_path: "a.ts",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
      }),
      text: async () => "",
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);

    const ref = resolveGlRef("group/proj", 7);
    const { diffText, diffRefs } = await getGlMrDiff(ref);
    expect(diffRefs.head_sha).toBe("h");
    expect(diffText).toContain("diff --git a/a.ts b/a.ts");
    expect(diffText).toContain("+new");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests/7/changes");
  });
});

describe("listGlWontFixFindingIds", () => {
  it("collects an agent finding id from a won't-fix reply", async () => {
    withEnv({ GITLAB_TOKEN: "tok" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 10,
          body: `Finding\n${AGENT_MARKER}\n[secondpair-id]: # (pr-review-id: AABBCCDDEEFF0011)`,
        },
        { id: 11, body: "False positive", parent_id: 10 },
        { id: 12, body: "Won't fix", parent_id: 999 },
      ],
      headers: { get: () => null },
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listGlWontFixFindingIds({
        serverUrl: "https://gitlab.com",
        projectId: "1",
        mrIid: 2,
      }),
    ).resolves.toEqual(new Set(["aabbccddeeff0011"]));
  });
});

describe("resolveGlDiscussionsForIds", () => {
  it("resolves only unresolved discussions containing a matching finding id", async () => {
    withEnv({ GITLAB_TOKEN: "tok" });
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method) {
        return {
          ok: true,
          json: async () => [
            {
              id: "discussion-1",
              notes: [
                {
                  body: "[secondpair-id]: # (pr-review-id: AABBCCDDEEFF0011)",
                  resolvable: true,
                  resolved: false,
                },
              ],
            },
            {
              id: "discussion-2",
              notes: [
                {
                  body: "[secondpair-id]: # (pr-review-id: AABBCCDDEEFF0011)",
                  resolvable: true,
                  resolved: true,
                },
              ],
            },
          ],
          headers: { get: () => null },
          text: async () => "",
        };
      }
      return { ok: true, json: async () => ({}), headers: { get: () => null }, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveGlDiscussionsForIds(
        { serverUrl: "https://gitlab.com", projectId: "1", mrIid: 2 },
        ["aabbccddeeff0011"],
      ),
    ).resolves.toBe(1);
    const puts = fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toContain("/discussions/discussion-1");
    expect(JSON.parse(puts[0][1]?.body as string)).toEqual({ resolved: true });
  });

  it("warns and continues when resolving a discussion fails", async () => {
    withEnv({ GITLAB_TOKEN: "tok" });
    const log = vi.fn();
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) {
        return {
          ok: true,
          json: async () => [
            {
              id: "discussion-1",
              notes: [
                {
                  body: "[secondpair-id]: # (pr-review-id: aabbccddeeff0011)",
                  resolvable: true,
                  resolved: false,
                },
              ],
            },
            {
              id: "discussion-2",
              notes: [
                {
                  body: "[secondpair-id]: # (pr-review-id: 1122334455667788)",
                  resolvable: true,
                  resolved: false,
                },
              ],
            },
          ],
          headers: { get: () => null },
          text: async () => "",
        };
      }
      if (String(_url).endsWith("discussion-1")) {
        return {
          ok: false,
          status: 403,
          json: async () => ({}),
          headers: { get: () => null },
          text: async () => "denied",
        };
      }
      return { ok: true, json: async () => ({}), headers: { get: () => null }, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveGlDiscussionsForIds(
        { serverUrl: "https://gitlab.com", projectId: "1", mrIid: 2 },
        ["aabbccddeeff0011", "1122334455667788"],
        log,
      ),
    ).resolves.toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^warn: .*denied/));
  });
});

describe("postGlReview", () => {
  it("posts summary note and skips duplicate finding ids", async () => {
    withEnv({ GITLAB_TOKEN: "tok" });
    const finding: Finding = {
      file: "a.ts",
      start_line: 1,
      end_line: 1,
      severity: "high",
      category: "bug",
      confidence: 0.9,
      title: "x",
      body: "y",
      suggestion: null,
      id: "abc123def4567890",
    };
    const result: ReviewResult = {
      summary: "s",
      findings: [finding],
      dropped: [],
      findingsToPost: [finding],
      reconciliation: {
        new: [],
        persistent: [],
        resolved: ["feedfacefeedface"],
        suppressed: [],
      },
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/notes") && (!init || init.method === "GET" || !init.method)) {
        return {
          ok: true,
          json: async () => [
            { body: `old\n[secondpair-id]: # (pr-review-id: abc123def4567890)\n${AGENT_MARKER}`, type: null },
          ],
          headers: { get: () => null },
          text: async () => "",
        };
      }
      if (String(url).includes("/discussions?") && (!init || init.method === "GET" || !init.method)) {
        return {
          ok: true,
          json: async () => [
            {
              id: "discussion-1",
              notes: [
                {
                  body: "[secondpair-id]: # (pr-review-id: feedfacefeedface)",
                  resolvable: true,
                  resolved: false,
                },
              ],
            },
          ],
          headers: { get: () => null },
          text: async () => "",
        };
      }
      return { ok: true, json: async () => ({}), headers: { get: () => null }, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    await postGlReview({
      ref: { serverUrl: "https://gitlab.com", projectId: "1", mrIid: 2 },
      diffRefs: { base_sha: "b", head_sha: "h", start_sha: "s" },
      result,
      failed: false,
    });

    const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    // summary may post; discussion for duplicate id should be skipped
    expect(posts.every((c) => !String(c[0]).includes("/discussions"))).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        (c) => String(c[0]).endsWith("/discussions/discussion-1") && c[1]?.method === "PUT",
      ),
    ).toBe(true);
  });
});
