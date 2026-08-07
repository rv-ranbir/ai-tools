export interface BbRef {
  workspace: string;
  repoSlug: string;
  prId: number;
}

/**
 * Resolve Bitbucket Cloud auth from the environment:
 *   BITBUCKET_TOKEN / BITBUCKET_ACCESS_TOKEN            -> Bearer (repository access token)
 *   BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD         -> Basic (app password)
 */
export function resolveBbAuthHeader(): string {
  const env = process.env;
  const token = env.BITBUCKET_TOKEN || env.BITBUCKET_ACCESS_TOKEN;
  if (token) return `Bearer ${token}`;
  if (env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD) {
    const basic = Buffer.from(`${env.BITBUCKET_USERNAME}:${env.BITBUCKET_APP_PASSWORD}`).toString(
      "base64",
    );
    return `Basic ${basic}`;
  }
  throw new Error(
    "Bitbucket auth required: set BITBUCKET_TOKEN (repository access token with pullrequest:write) " +
      "or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD.",
  );
}

/** Resolve workspace/repo/PR id from flags or Bitbucket Pipelines env vars. */
export function resolveBbRef(repoSlug: string | undefined, pr: number | undefined): BbRef {
  const env = process.env;
  let workspace: string | undefined;
  let slug: string | undefined;
  if (repoSlug) {
    [workspace, slug] = repoSlug.split("/");
  } else {
    workspace = env.BITBUCKET_WORKSPACE;
    slug = env.BITBUCKET_REPO_SLUG;
  }
  const prId = pr ?? (env.BITBUCKET_PR_ID ? parseInt(env.BITBUCKET_PR_ID, 10) : undefined);
  if (!workspace || !slug || prId == null || Number.isNaN(prId)) {
    throw new Error(
      "Bitbucket PR not identified. Pass --repo workspace/repo_slug and --pr <id>, " +
        "or run inside Bitbucket Pipelines (BITBUCKET_WORKSPACE / BITBUCKET_REPO_SLUG / BITBUCKET_PR_ID).",
    );
  }
  return { workspace, repoSlug: slug, prId };
}
