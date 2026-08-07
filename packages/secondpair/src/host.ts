export type Host = "github" | "bitbucket" | "gitlab";

/** Resolve which platform to talk to: explicit --host flag, else detected from CI env vars. */
export function detectHost(explicit: string | undefined): Host {
  const env = process.env;
  const host =
    explicit ??
    (env.BITBUCKET_WORKSPACE || env.BITBUCKET_PR_ID
      ? "bitbucket"
      : env.GITLAB_CI
        ? "gitlab"
        : "github");
  if (host !== "github" && host !== "bitbucket" && host !== "gitlab") {
    throw new Error(`--host must be github, bitbucket, or gitlab, got "${explicit}".`);
  }
  return host;
}
