export interface GlRef {
  /** GitLab server base URL, e.g. https://gitlab.com */
  serverUrl: string;
  /** URL-encoded project path ("group%2Fproject") or numeric project id. */
  projectId: string;
  mrIid: number;
}

/** Resolve a GitLab token from the environment. CI_JOB_TOKEN cannot post MR notes. */
export function resolveGlToken(): string {
  const token = process.env.GITLAB_TOKEN || process.env.GL_TOKEN;
  if (!token) {
    throw new Error(
      "GitLab auth required: set GITLAB_TOKEN (personal or project access token with api scope). " +
        "CI_JOB_TOKEN cannot post merge request notes.",
    );
  }
  return token;
}

/** Resolve project/MR from flags or GitLab CI env vars. */
export function resolveGlRef(repoSlug: string | undefined, pr: number | undefined): GlRef {
  const env = process.env;
  const serverUrl = (env.CI_SERVER_URL || "https://gitlab.com").replace(/\/$/, "");
  const projectId = repoSlug ? encodeURIComponent(repoSlug) : env.CI_PROJECT_ID;
  const mrIid = pr ?? (env.CI_MERGE_REQUEST_IID ? parseInt(env.CI_MERGE_REQUEST_IID, 10) : undefined);
  if (!projectId || mrIid == null || Number.isNaN(mrIid)) {
    throw new Error(
      "GitLab MR not identified. Pass --repo group/project and --pr <iid>, " +
        "or run in a merge_request_event pipeline (CI_PROJECT_ID / CI_MERGE_REQUEST_IID).",
    );
  }
  return { serverUrl, projectId, mrIid };
}
