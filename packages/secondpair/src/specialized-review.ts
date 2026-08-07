import { structuredCall } from "repocairn";
import {
  CORRECTNESS_LENS_SYSTEM_PROMPT,
  QUALITY_LENS_SYSTEM_PROMPT,
  SECURITY_LENS_SYSTEM_PROMPT,
  buildReviewUserPrompt,
} from "./llm/prompt.js";
import { reviewOutputSchema, type ReviewOutput } from "./llm/schema.js";
import { withRetry } from "./retry.js";
import type { Category, FileDiff, ReviewConfig } from "./types.js";

export interface LensDefinition {
  key: string;
  categories: Category[];
  systemPrompt: string;
  /** Whether this lens receives repository context and signals, or the diff alone. */
  includeContext: boolean;
}

/** Partitions the frozen Category enum three ways so lens outputs can never collide on dedupeById's file|category|title fingerprint. */
export const LENS_DEFINITIONS: LensDefinition[] = [
  { key: "security", categories: ["security"], systemPrompt: SECURITY_LENS_SYSTEM_PROMPT, includeContext: true },
  {
    key: "correctness",
    categories: ["bug", "missing-tests"],
    systemPrompt: CORRECTNESS_LENS_SYSTEM_PROMPT,
    includeContext: true,
  },
  {
    key: "quality",
    categories: ["naming", "complexity", "custom"],
    systemPrompt: QUALITY_LENS_SYSTEM_PROMPT,
    includeContext: false,
  },
];

export interface LensStat {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SpecializedReviewInput {
  files: FileDiff[];
  context: string;
  signalsText: string;
  config: ReviewConfig;
  changeDescription: string;
  temperature: number | undefined;
}

/** Runs the 3 category lenses concurrently over one chunk of files, each scoped to its own category slice. */
export async function runSpecializedReview(
  input: SpecializedReviewInput,
): Promise<{ outputs: ReviewOutput[]; lensStats: Record<string, LensStat> }> {
  const lensStats: Record<string, LensStat> = {};
  const outputs = await Promise.all(
    LENS_DEFINITIONS.map(async (lens) => {
      const stat: LensStat = { calls: 0, inputTokens: 0, outputTokens: 0 };
      lensStats[lens.key] = stat;
      const user = buildReviewUserPrompt({
        files: input.files,
        context: lens.includeContext ? input.context : "",
        config: input.config,
        changeDescription: input.changeDescription,
        signals: lens.includeContext ? input.signalsText : undefined,
      });
      const output = await withRetry(() =>
        structuredCall({
          system: lens.systemPrompt,
          user,
          schema: reviewOutputSchema,
          schemaName: "review_output",
          temperature: input.temperature,
          onUsage: (u) => {
            stat.inputTokens += u.inputTokens;
            stat.outputTokens += u.outputTokens;
          },
        }),
      );
      stat.calls += 1;
      return { ...output, findings: output.findings.filter((f) => lens.categories.includes(f.category)) };
    }),
  );
  return { outputs, lensStats };
}
