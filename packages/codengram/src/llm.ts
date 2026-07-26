import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { estimateTokens } from "./graph.js";

export type Provider = "anthropic" | "openai-compatible" | "cli";

export interface ProviderSettings {
  provider: Provider;
  model: string;
  /** Only used by the openai-compatible provider. */
  baseUrl: string;
  /** Only used by the openai-compatible provider. */
  apiKey: string;
  /** Only used by the cli provider: full command line reading a prompt on stdin, printing JSON on stdout. */
  cliCommand?: string;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Resolve which LLM provider to call.
 *
 * Explicit: CODENGRAM_PROVIDER=anthropic | openai | openrouter | openai-compatible.
 * Otherwise inferred from which API key env vars are set:
 *   ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN -> Anthropic (official SDK)
 *   OPENROUTER_API_KEY                        -> OpenRouter (openai-compatible)
 *   OPENAI_API_KEY                            -> OpenAI or any compatible endpoint
 * Any OpenAI-compatible endpoint (Cursor, LiteLLM, vLLM, Together, …) works via
 * CODENGRAM_BASE_URL + CODENGRAM_API_KEY.
 * PR_REVIEW_* spellings of every CODENGRAM_* var are accepted as aliases.
 */
export function resolveProvider(): ProviderSettings {
  const env = process.env;
  const explicit = (env.CODENGRAM_PROVIDER || env.PR_REVIEW_PROVIDER || "").toLowerCase();
  const model = env.CODENGRAM_MODEL || env.PR_REVIEW_MODEL || env.ANTHROPIC_MODEL || "";

  const openAiCompatible = (baseUrl: string, apiKey: string): ProviderSettings => {
    if (!model) {
      throw new Error(
        "Set CODENGRAM_MODEL (or PR_REVIEW_MODEL) when using an OpenAI-compatible provider (e.g. gpt-4o, or anthropic/claude-sonnet-4.5 on OpenRouter).",
      );
    }
    if (!apiKey) {
      throw new Error(
        "No API key found for the OpenAI-compatible provider. Set CODENGRAM_API_KEY or PR_REVIEW_API_KEY (or OPENROUTER_API_KEY / OPENAI_API_KEY).",
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

  const customBase = env.CODENGRAM_BASE_URL || env.PR_REVIEW_BASE_URL || env.OPENAI_BASE_URL || "";
  const genericKey = env.CODENGRAM_API_KEY || env.PR_REVIEW_API_KEY || "";
  const cliCommand = env.CODENGRAM_CLI_COMMAND || env.PR_REVIEW_CLI_COMMAND || "";

  const cli = (): ProviderSettings => {
    if (!cliCommand) {
      throw new Error(
        'provider "cli" needs CODENGRAM_CLI_COMMAND (or PR_REVIEW_CLI_COMMAND), e.g. "cursor-agent -p" or "claude -p".',
      );
    }
    const cliModel = cliCommand.split(/\s+/)[0]?.replace(/^["']|["']$/g, "") || "cli";
    return { provider: "cli", model: model || cliModel, baseUrl: "", apiKey: "", cliCommand };
  };

  switch (explicit) {
    case "anthropic":
      return anthropic();
    case "cli":
      return cli();
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
        `Unknown provider "${env.CODENGRAM_PROVIDER || env.PR_REVIEW_PROVIDER}". Use anthropic, openai, openrouter, openai-compatible, or cli.`,
      );
  }

  // Auto-detect from available keys.
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return anthropic();
  if (cliCommand) return cli();
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

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredCallOptions<S extends z.ZodType> {
  system: string;
  user: string;
  schema: S;
  schemaName: string;
  maxTokens?: number;
  /**
   * Sampling temperature. OpenAI-compatible providers default to 0 for
   * repeatable output. Anthropic: setting this disables adaptive thinking
   * (the API forbids combining them); leave unset to keep thinking on.
   */
  temperature?: number;
  /** Called with token usage when the provider reports it (not on cli). */
  onUsage?: (usage: LlmUsage) => void;
}

/**
 * Single structured LLM call returning an object validated against the zod schema.
 * Anthropic: schema-constrained output via the official SDK (adaptive thinking on).
 * OpenAI-compatible: JSON mode + client-side zod validation with one repair retry.
 * cli: pipes the prompt to a local agent command (cursor-agent, claude, …) via stdin.
 */
export async function structuredCall<S extends z.ZodType>(
  opts: StructuredCallOptions<S>,
): Promise<z.infer<S>> {
  const settings = resolveProvider();
  if (settings.provider === "anthropic") {
    return anthropicStructuredCall(settings, opts);
  }
  if (settings.provider === "cli") {
    return cliStructuredCall(settings, opts);
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
    // The API forbids temperature together with thinking — an explicit
    // temperature trades adaptive thinking for repeatability.
    ...(opts.temperature != null
      ? { temperature: opts.temperature }
      : { thinking: { type: "adaptive" as const } }),
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.user }],
    output_config: { format: zodOutputFormat(opts.schema) },
  });

  if (response.usage) {
    opts.onUsage?.({
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
    });
  }

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
      temperature: opts.temperature ?? 0,
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
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (data.usage) {
      opts.onUsage?.({
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
      });
    }
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

/**
 * Pipe the prompt to a local agent CLI (cursor-agent, claude, …) and parse its
 * stdout as JSON. Contract: the command reads the full prompt on stdin and
 * prints a single JSON object (surrounding prose/fences are tolerated).
 */
async function cliStructuredCall<S extends z.ZodType>(
  settings: ProviderSettings,
  opts: StructuredCallOptions<S>,
): Promise<z.infer<S>> {
  const jsonSchema = JSON.stringify(zodOutputFormat(opts.schema).schema);

  const run = (extraUser: string | null) =>
    new Promise<{ prompt: string; out: string }>((resolve, reject) => {
      // shell:true — the command is a user-configured command line, not a path
      const child = spawn(settings.cliCommand!, { shell: true, windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c));
      child.stderr.on("data", (c: Buffer) => (err += c));
      child.on("error", reject);
      const prompt = [
        opts.system,
        `Respond with ONLY a JSON object matching this JSON schema (no prose, no markdown fences):\n${jsonSchema}`,
        opts.user,
        extraUser ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`CLI provider exited ${code}: ${err.slice(0, 500) || out.slice(0, 500)}`));
        } else resolve({ prompt, out });
      });
      child.stdin.end(prompt);
    });

  // CLI agents don't report token usage on stdout in text mode; estimate from
  // the actual prompt/response of whichever attempt succeeded.
  const reportUsage = (prompt: string, out: string) =>
    opts.onUsage?.({ inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(out) });

  const firstRun = await run(null);
  const first = tryParse(opts.schema, firstRun.out);
  if (first.ok) {
    reportUsage(firstRun.prompt, firstRun.out);
    return first.value;
  }
  const secondRun = await run(
    `Your previous response failed validation:\n${first.error}\nReturn a corrected JSON object matching the schema exactly.`,
  );
  const second = tryParse(opts.schema, secondRun.out);
  if (second.ok) {
    reportUsage(secondRun.prompt, secondRun.out);
    return second.value;
  }
  throw new Error(`CLI provider output failed schema validation after retry: ${second.error}`);
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
    // Agent CLIs often wrap the JSON in prose/fences — retry on the outermost {...} span.
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
    }
    try {
      raw = JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
    }
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
}
