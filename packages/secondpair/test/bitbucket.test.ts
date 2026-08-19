import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatBbCommentBody,
  formatBbSummaryBody,
  listBbWontFixFindingIds,
  postBbReview,
  resolveBbCommentsForIds,
} from "../src/bitbucket/comments.js";
import { AGENT_MARKER } from "../src/github/comments.js";
import type { Finding, ReviewResult } from "../src/types.js";

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
  vi.unstubAllGlobals();
});

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

describe("listBbWontFixFindingIds", () => {
  it("collects an agent finding id through a comment parent chain", async () => {
    withEnv({ BITBUCKET_TOKEN: "tok" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          values: [
            {
              id: 10,
              content: {
                raw: `Finding\n${AGENT_MARKER}\n[secondpair-id]: # (pr-review-id: AABBCCDDEEFF0011)`,
              },
            },
            { id: 11, content: { raw: "context" }, parent: { id: 10 } },
            { id: 12, content: { raw: "Not a bug" }, parent: { id: 11 } },
            { id: 13, content: { raw: "Won't fix" }, parent: { id: 999 } },
          ],
        }),
        text: async () => "",
      }),
    );

    await expect(
      listBbWontFixFindingIds({ workspace: "acme", repoSlug: "api", prId: 7 }),
    ).resolves.toEqual(new Set(["aabbccddeeff0011"]));
  });
});

describe("resolveBbCommentsForIds", () => {
  it("logs that Bitbucket soft-resolve is unsupported", async () => {
    const log = vi.fn();
    await expect(
      resolveBbCommentsForIds(
        { workspace: "acme", repoSlug: "api", prId: 7 },
        ["aabbccddeeff0011"],
        log,
      ),
    ).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith("Bitbucket: soft-resolve not supported; skipping");
  });

  it("is called by postBbReview after posting", async () => {
    withEnv({ BITBUCKET_TOKEN: "tok" });
    const log = vi.fn();
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) {
        return {
          ok: true,
          json: async () => ({ values: [] }),
          headers: { get: () => null },
          text: async () => "",
        };
      }
      return { ok: true, json: async () => ({}), headers: { get: () => null }, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);
    const result: ReviewResult = {
      summary: "done",
      findings: [],
      dropped: [],
      reconciliation: {
        new: [],
        persistent: [],
        resolved: ["aabbccddeeff0011"],
        suppressed: [],
      },
    };

    await postBbReview({
      ref: { workspace: "acme", repoSlug: "api", prId: 7 },
      result,
      failed: false,
      log,
    });

    expect(
      log.mock.calls.findIndex(
        ([message]) => message === "Bitbucket: soft-resolve not supported; skipping",
      ),
    ).toBeGreaterThan(
      log.mock.calls.findIndex(([message]) => String(message).startsWith("Bitbucket: posted")),
    );
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

  it("summary shows the high-level-review banner when set", () => {
    const body = formatBbSummaryBody(
      { summary: "Big diff.", findings: [], dropped: [], highLevelReview: true },
      false,
    );
    expect(body).toContain("Large diff");
    expect(body).toContain("high-level review only");
  });
});
