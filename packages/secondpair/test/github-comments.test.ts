import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { withFindingId } from "../src/finding-id.js";
import {
  AGENT_MARKER,
  formatCommentBody,
  formatReviewBody,
  listWontFixFindingIds,
  postReview,
  resolveThreadsForIds,
} from "../src/github/comments.js";
import type { Finding, ReviewResult } from "../src/types.js";

describe("formatReviewBody", () => {
  it("shows the high-level-review banner when set", () => {
    const body = formatReviewBody({ summary: "Big diff.", findings: [], dropped: [], highLevelReview: true }, false);
    expect(body).toContain("Large diff");
    expect(body).toContain("high-level review only");
  });

  it("omits the banner when unset (regression)", () => {
    const body = formatReviewBody({ summary: "Looks good.", findings: [], dropped: [] }, false);
    expect(body).not.toContain("high-level review only");
  });
});

describe("listWontFixFindingIds", () => {
  it("collects an agent finding id from a won't-fix reply", async () => {
    const comments = [
      {
        id: 10,
        body: `Finding\n${AGENT_MARKER}\n<!-- pr-review-id: AABBCCDDEEFF0011 -->`,
      },
      { id: 11, body: "Won't fix — intentional.", in_reply_to_id: 10 },
      { id: 12, body: "Won't fix", in_reply_to_id: 999 },
    ];
    const octokit = {
      paginate: vi.fn().mockResolvedValue(comments),
      pulls: { listReviewComments: vi.fn() },
    } as unknown as Octokit;

    await expect(
      listWontFixFindingIds(octokit, { owner: "acme", repo: "api", pull_number: 7 }),
    ).resolves.toEqual(new Set(["aabbccddeeff0011"]));
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.pulls.listReviewComments,
      { owner: "acme", repo: "api", pull_number: 7, per_page: 100 },
    );
  });
});

describe("resolveThreadsForIds", () => {
  it("resolves only unresolved threads containing a matching finding id", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-1",
                  isResolved: false,
                  comments: {
                    nodes: [{ body: "<!-- pr-review-id: AABBCCDDEEFF0011 -->" }],
                  },
                },
                {
                  id: "thread-2",
                  isResolved: true,
                  comments: {
                    nodes: [{ body: "<!-- pr-review-id: AABBCCDDEEFF0011 -->" }],
                  },
                },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        resolveReviewThread: { thread: { isResolved: true } },
      });
    const octokit = { graphql } as unknown as Octokit;

    await expect(
      resolveThreadsForIds(
        octokit,
        { owner: "acme", repo: "api", pull_number: 7 },
        ["aabbccddeeff0011"],
      ),
    ).resolves.toBe(1);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1]).toEqual({ id: "thread-1" });
  });

  it("continues after a resolve mutation fails", async () => {
    const log = vi.fn();
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-1",
                  isResolved: false,
                  comments: {
                    nodes: [{ body: "<!-- pr-review-id: aabbccddeeff0011 -->" }],
                  },
                },
                {
                  id: "thread-2",
                  isResolved: false,
                  comments: {
                    nodes: [{ body: "<!-- pr-review-id: 1122334455667788 -->" }],
                  },
                },
              ],
            },
          },
        },
      })
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce({
        resolveReviewThread: { thread: { isResolved: true } },
      });
    const octokit = { graphql } as unknown as Octokit;

    await expect(
      resolveThreadsForIds(
        octokit,
        { owner: "acme", repo: "api", pull_number: 7 },
        ["aabbccddeeff0011", "1122334455667788"],
        log,
      ),
    ).resolves.toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^warn: .*denied/));
  });

  it("checks every review-thread page", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-101",
                  isResolved: false,
                  comments: {
                    nodes: [{ body: "<!-- pr-review-id: aabbccddeeff0011 -->" }],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        resolveReviewThread: { thread: { isResolved: true } },
      });
    const octokit = { graphql } as unknown as Octokit;

    await expect(
      resolveThreadsForIds(
        octokit,
        { owner: "acme", repo: "api", pull_number: 7 },
        ["aabbccddeeff0011"],
      ),
    ).resolves.toBe(1);
    expect(graphql.mock.calls[1][1]).toEqual({
      owner: "acme",
      repo: "api",
      number: 7,
      cursor: "cursor-1",
    });
    expect(graphql.mock.calls[2][1]).toEqual({ id: "thread-101" });
  });
});

describe("postReview", () => {
  it("resolves reconciled threads after posting", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-1",
                  isResolved: false,
                  comments: {
                    nodes: [{ body: "<!-- pr-review-id: aabbccddeeff0011 -->" }],
                  },
                },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        resolveReviewThread: { thread: { isResolved: true } },
      });
    const octokit = {
      graphql,
      paginate: vi.fn().mockResolvedValue([]),
      pulls: {
        listReviewComments: vi.fn(),
        createReview: vi.fn().mockResolvedValue({}),
      },
    } as unknown as Octokit;

    await postReview({
      octokit,
      pr: { owner: "acme", repo: "api", pull_number: 7 },
      headSha: "abc",
      result: {
        summary: "done",
        findings: [],
        dropped: [],
        reconciliation: {
          new: [],
          persistent: [],
          resolved: ["aabbccddeeff0011"],
          suppressed: [],
        },
      },
      failed: false,
    });

    expect(octokit.pulls.createReview).toHaveBeenCalledOnce();
    expect(graphql.mock.calls[1][1]).toEqual({ id: "thread-1" });
  });

  it("does not re-post the same finding when the diff is reviewed again (repeat-push dedupe)", async () => {
    const finding: Finding = withFindingId({
      file: "src/math.ts",
      start_line: 2,
      end_line: 3,
      severity: "high",
      category: "bug",
      confidence: 0.95,
      title: "Loop reads past the end of the array",
      body: "off-by-one",
      suggestion: null,
    });
    const result: ReviewResult = {
      summary: "same bug",
      findings: [finding],
      dropped: [],
      findingsToPost: [finding],
      reconciliation: { new: [finding.id!], persistent: [], resolved: [], suppressed: [] },
    };

    // Run 1: PR has no comments yet — the finding should be posted.
    const createReview1 = vi.fn().mockResolvedValue({});
    const octokit1 = {
      paginate: vi.fn().mockResolvedValue([]), // no existing comments
      pulls: { listReviewComments: vi.fn(), createReview: createReview1 },
    } as unknown as Octokit;

    await postReview({
      octokit: octokit1,
      pr: { owner: "acme", repo: "api", pull_number: 7 },
      headSha: "sha1",
      result,
      failed: false,
    });

    expect(createReview1).toHaveBeenCalledOnce();
    const postedComments = createReview1.mock.calls[0][0].comments as { body: string }[];
    expect(postedComments).toHaveLength(1);

    // Run 2: same diff reviewed again (e.g. re-triggered CI). The PR now
    // already has the comment posted in run 1 — pretend the API returns it.
    const createReview2 = vi.fn().mockResolvedValue({});
    const octokit2 = {
      paginate: vi.fn().mockResolvedValue(
        postedComments.map((c) => ({ body: c.body })),
      ),
      pulls: { listReviewComments: vi.fn(), createReview: createReview2 },
    } as unknown as Octokit;
    const log = vi.fn();

    await postReview({
      octokit: octokit2,
      pr: { owner: "acme", repo: "api", pull_number: 7 },
      headSha: "sha2",
      result, // identical findings/ids — same fingerprint, LLM re-ran on same diff
      failed: false,
      log,
    });

    expect(createReview2).toHaveBeenCalledOnce();
    const secondComments = createReview2.mock.calls[0][0].comments as unknown[];
    expect(secondComments).toHaveLength(0); // nothing new to post — already there
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Skipping 1 comment/));
  });

  it("does not re-post across three consecutive runs of the same diff", async () => {
    const finding: Finding = withFindingId({
      file: "src/a.ts",
      start_line: 1,
      end_line: 1,
      severity: "medium",
      category: "naming",
      confidence: 0.8,
      title: "Unclear variable name",
      body: "x",
      suggestion: null,
    });
    const commentBody = formatCommentBody(finding);
    const pr = { owner: "acme", repo: "api", pull_number: 42 };

    // Server-side state: comments accumulate (or don't) across the 3 runs.
    let serverComments: { body: string }[] = [];

    for (let run = 1; run <= 3; run++) {
      const createReview = vi.fn().mockResolvedValue({});
      const octokit = {
        paginate: vi.fn().mockResolvedValue(serverComments),
        pulls: { listReviewComments: vi.fn(), createReview },
      } as unknown as Octokit;

      await postReview({
        octokit,
        pr,
        headSha: `sha${run}`,
        result: {
          summary: "run " + run,
          findings: [finding],
          dropped: [],
          findingsToPost: [finding], // pipeline always includes it; postReview must filter
          reconciliation: { new: [], persistent: [finding.id!], resolved: [], suppressed: [] },
        },
        failed: false,
      });

      const comments = createReview.mock.calls[0][0].comments as { body: string }[];
      if (run === 1) {
        expect(comments).toHaveLength(1);
        serverComments = [{ body: commentBody }];
      } else {
        expect(comments).toHaveLength(0);
      }
    }
  });
});
