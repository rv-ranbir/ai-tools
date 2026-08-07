/** Resolve a GitHub token from the environment. */
export function resolveGhToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("A GitHub token is required (GITHUB_TOKEN env var).");
  }
  return token;
}

/** Resolve owner/name from an explicit --repo flag or the GITHUB_REPOSITORY env var. */
export function resolveGhRepoSlug(explicit: string | undefined): string {
  const slug = explicit ?? process.env.GITHUB_REPOSITORY;
  if (!slug) throw new Error("Pass --repo owner/name or set GITHUB_REPOSITORY when using --pr.");
  return slug;
}
