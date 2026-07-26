import type { FileDiff, ReviewConfig } from "../types.js";
import { renderDiffForPrompt } from "../diff/parse.js";

export const REVIEW_SYSTEM_PROMPT = `You are a senior software engineer reviewing a pull request. You are rigorous but pragmatic: you flag real problems, not style preferences the team hasn't asked for.

Review the diff for these categories:
- bug: logic errors, off-by-one mistakes, incorrect conditions, broken error handling, race conditions, wrong API usage
- security: injection, unsafe deserialization, secrets in code, missing authorization or validation at trust boundaries, path traversal
- missing-tests: changed or new behavior with no corresponding test change, especially branches and error paths
- naming: identifiers inconsistent with the surrounding codebase's conventions, or misleading about what they do
- complexity: functions that grew too long or deeply nested to reason about, duplicated logic that already exists elsewhere in the repo
- custom: anything the repository's custom instructions ask you to flag

Rules:
1. Comment ONLY on lines that appear as added (+) lines in the diff. Use the new-file line numbers printed at the start of each line.
2. Use the REPOSITORY CONTEXT section (summaries and symbols of related files) to judge consistency, spot callers the change might break, and avoid flagging things the codebase already handles elsewhere. Do not report findings about context files themselves — only about the diff.
3. Severity rubric:
   - critical: will corrupt data, break production, or is an exploitable vulnerability
   - high: incorrect behavior on realistic inputs, or a security weakness
   - medium: likely bug under edge cases, missing tests for risky logic, significant maintainability problem
   - low: minor issues worth fixing but not blocking
   - info: observations and suggestions, no action strictly required
4. Report every real issue you find, including ones you are uncertain about — set confidence accordingly; a downstream filter handles thresholds. Do not pad the review with nitpicks to seem thorough.
5. When you provide a suggestion, it must be a drop-in replacement for exactly the lines in start_line..end_line, complete and correctly indented.
6. Keep each finding's body focused: what is wrong, why it matters, how to fix it.
7. When the REPOSITORY CONTEXT contradicts a suspicion (the pattern is established elsewhere, a caller already handles the case, a convention explains the choice), do not report it as high or critical unless you can cite the specific added lines that break it — cite that evidence in the body, or lower the severity and confidence accordingly. Never report a critical/high finding that rests on guesses about code you cannot see.`;

export const CRITIQUE_SYSTEM_PROMPT = `You are re-reading your own PR review before it is posted. Your ONLY job is to remove findings you would walk back if a developer pushed back — speculative issues, style opinions dressed as bugs, problems the surrounding code or repository context already handles, or duplicates.

Rules:
1. You may ONLY drop findings. Never edit, merge, reword, or add findings.
2. Keep every finding you would defend in a face-to-face review — when in doubt, keep it. Dropping a real bug is far worse than keeping a borderline nitpick.
3. Return the ids of the findings to KEEP.`;

export function buildCritiqueUserPrompt(input: {
  findings: { id?: string; file: string; start_line: number; severity: string; title: string; body: string }[];
  changeDescription: string;
}): string {
  const list = input.findings
    .map(
      (f) =>
        `- id: ${f.id}\n  location: ${f.file}:${f.start_line} [${f.severity}]\n  title: ${f.title}\n  body: ${f.body}`,
    )
    .join("\n");
  return `Change under review: ${input.changeDescription}\n\n# FINDINGS\n${list}\n\nReturn the ids to keep.`;
}

export interface ReviewPromptInput {
  files: FileDiff[];
  /** Rendered repository context from the codemap; empty when no index exists. */
  context: string;
  config: ReviewConfig;
  /** e.g. "PR #42: Add session refresh" or "local diff vs origin/main" */
  changeDescription: string;
}

export function buildReviewUserPrompt(input: ReviewPromptInput): string {
  const parts: string[] = [];

  parts.push(`Reviewing: ${input.changeDescription}`);

  if (input.config.custom_instructions.trim()) {
    parts.push(`# CUSTOM REVIEW INSTRUCTIONS (from this repository's .pr-review.yml)\n${input.config.custom_instructions.trim()}`);
  }

  if (input.context.trim()) {
    parts.push(`# REPOSITORY CONTEXT\nSummaries and exported symbols of files related to this change (importers listed first — they depend on the changed code):\n\n${input.context}`);
  } else {
    parts.push(`# REPOSITORY CONTEXT\n(none available — no codemap index; review the diff on its own)`);
  }

  const diffs = input.files.map((f) => renderDiffForPrompt(f)).join("\n\n");
  parts.push(`# DIFF\nEach line is prefixed with its new-file line number. Only '+' lines are commentable.\n\n${diffs}`);

  return parts.join("\n\n");
}
