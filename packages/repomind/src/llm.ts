import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export type Provider = "anthropic" | "openai-compatible";

export interface ProviderSettings {
  provider: Provider;
  model: string;
  /** Only used by the openai-compatible provider. */
  baseUrl: string;
  /** Only used by the openai-compatible provider. */
  apiKey: string;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Resolve which LLM provider to call.
 *
 * Explicit: REPOMIND_PROVIDER=anthropic | openai | openrouter | openai-compatible.
 * Otherwise inferred from which API key env vars are set:
 *   ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN -> Anthropic (official SDK)
 *   OPENROUTER_API_KEY                        -> OpenRouter (openai-compatible)
 *   OPENAI_API_KEY                            -> OpenAI or any compatible endpoint
 * Any OpenAI-compatible endpoint (Cursor, LiteLLM, vLLM, Together, …) works via
 * REPOMIND_BASE_URL + REPOMIND_API_KEY.
 * PR_REVIEW_* spellings of every REPOMIND_* var are accepted as aliases.
 */
export function resolveProvider(): ProviderSettings {
  const env = process.env;
  const explicit = (env.REPOMIND_PROVIDER || env.PR_REVIEW_PROVIDER || "").toLowerCase();
  const model = env.REPOMIND_MODEL || env.PR_REVIEW_MODEL || env.ANTHROPIC_MODEL || "";

  const openAiCompatible = (baseUrl: string, apiKey: string): ProviderSettings => {
    if (!model) {
      throw new Error(
        "Set REPOMIND_MODEL (or PR_REVIEW_MODEL) when using an OpenAI-compatible provider (e.g. gpt-4o, or anthropic/claude-sonnet-4.5 on OpenRouter).",
      );
    }
    if (!apiKey) {
      throw new Error(
        "No API key found for the OpenAI-compatible provider. Set REPOMIND_API_KEY or PR_REVIEW_API_KEY (or OPENROUTER_API_KEY / OPENAI_API_KEY).",
      );
    }
    return { provider: "openai-compatible", model, baseUrl, apiKey };
  };

  const anthropic = (): ProviderSettings => ({
    provider: "anthropic",
    model: model || DEFAULT_ANTHROPIC_MODEL,
    baseUrl: "",
    apiKey: "",
  });

  const customBase = env.REPOMIND_BASE_URL || env.PR_REVIEW_BASE_URL || env.OPENAI_BASE_URL || "";
  const genericKey = env.REPOMIND_API_KEY || env.PR_REVIEW_API_KEY || "";

  switch (explicit) {
    case "anthropic":
      return anthropic();
    case "openrouter":
      return openAiCompatible(customBase || OPENROUTER_BASE_URL, genericKey || env.OPENROUTER_API_KEY || "");
    case "openai":
    case "openai-compatible":
      return openAiCompatible(
        customBase || OPENAI_BASE_URL,
        genericKey || env.OPENAI_API_KEY || "",
      );
    case "":
      break;
    default:
      throw new Error(
        `Unknown provider "${env.REPOMIND_PROVIDER || env.PR_REVIEW_PROVIDER}". Use anthropic, openai, openrouter, or openai-compatible.`,
      );
  }

  // Auto-detect from available keys.
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return anthropic();
  if (env.OPENROUTER_API_KEY) {
    return openAiCompatible(customBase || OPENROUTER_BASE_URL, env.OPENROUTER_API_KEY);
  }
  if (env.OPENAI_API_KEY || (customBase && genericKey)) {
    return openAiCompatible(customBase || OPENAI_BASE_URL, genericKey || env.OPENAI_API_KEY || "");
  }
  // Fall through to the Anthropic SDK, which can also resolve `ant auth login` profiles.
  return anthropic();
}

export function getModel(): string {
  return resolveProvider().model;
}

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

export interface StructuredCallOptions<S extends z.ZodType> {
  system: string;
  user: string;
  schema: S;
  schemaName: string;
  maxTokens?: number;
}

/**
 * Single structured LLM call returning an object validated against the zod schema.
 * Anthropic: schema-constrained output via the official SDK (adaptive thinking on).
 * OpenAI-compatible: JSON mode + client-side zod validation with one repair retry.
 */
export async function structuredCall<S extends z.ZodType>(
  opts: StructuredCallOptions<S>,
): Promise<z.infer<S>> {
  const settings = resolveProvider();
  if (settings.provider === "anthropic") {
    return anthropicStructuredCall(settings, opts);
  }
  return openAiCompatibleStructuredCall(settings, opts);
}

async function anthropicStructuredCall<S extends z.ZodType>(
  settings: ProviderSettings,
  opts: StructuredCallOptions<S>,
): Promise<z.infer<S>> {
  const client = getAnthropicClient();
  const response = await client.messages.parse({
    model: settings.model,
    max_tokens: opts.maxTokens ?? 16000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.user }],
    output_config: { format: zodOutputFormat(opts.schema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined this request (stop_reason: refusal).");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Model output was truncated (stop_reason: max_tokens). Try a smaller diff or raise max_tokens.",
    );
  }
  if (response.parsed_output == null) {
    throw new Error("Model returned output that did not match the expected schema.");
  }
  return response.parsed_output;
}

async function openAiCompatibleStructuredCall<S extends z.ZodType>(
  settings: ProviderSettings,
  opts: StructuredCallOptions<S>,
): Promise<z.infer<S>> {
  // Reuse the Anthropic helper purely to convert zod -> JSON schema (no API call).
  const jsonSchema = zodOutputFormat(opts.schema).schema;

  const call = async (extraUser: string | null, useJsonSchemaFormat: boolean) => {
    const body: Record<string, unknown> = {
      model: settings.model,
      max_tokens: opts.maxTokens ?? 16000,
      messages: [
        {
          role: "system",
          content: `${opts.system}\n\nRespond ONLY with a JSON object matching this JSON schema (no markdown fences, no prose):\n${JSON.stringify(jsonSchema)}`,
        },
        { role: "user", content: extraUser ? `${opts.user}\n\n${extraUser}` : opts.user },
      ],
      response_format: useJsonSchemaFormat
        ? { type: "json_schema", json_schema: { name: opts.schemaName, strict: true, schema: jsonSchema } }
        : { type: "json_object" },
    };

    const res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM response contained no message content.");
    return content;
  };

  let content: string;
  try {
    content = await call(null, true);
  } catch (err) {
    // Some providers/models reject json_schema response_format — fall back to JSON mode.
    if ((err as { status?: number }).status === 400) {
      content = await call(null, false);
    } else {
      throw err;
    }
  }

  const first = tryParse(opts.schema, content);
  if (first.ok) return first.value;

  // One repair retry with the validation errors.
  const repaired = await call(
    `Your previous response failed validation:\n${first.error}\nReturn a corrected JSON object matching the schema exactly.`,
    false,
  );
  const second = tryParse(opts.schema, repaired);
  if (second.ok) return second.value;
  throw new Error(`Model output failed schema validation after retry: ${second.error}`);
}

function tryParse<S extends z.ZodType>(
  schema: S,
  content: string,
): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
}
