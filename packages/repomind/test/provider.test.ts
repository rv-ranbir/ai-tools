import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  resolveProvider,
} from "../src/llm.js";

const PROVIDER_ENV_VARS = [
  "REPOMIND_PROVIDER",
  "REPOMIND_MODEL",
  "REPOMIND_BASE_URL",
  "REPOMIND_API_KEY",
  "PR_REVIEW_PROVIDER",
  "PR_REVIEW_MODEL",
  "PR_REVIEW_BASE_URL",
  "PR_REVIEW_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
];

function withEnv(env: Record<string, string>) {
  for (const key of PROVIDER_ENV_VARS) vi.stubEnv(key, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

describe("resolveProvider", () => {
  it("uses Anthropic with the default model when ANTHROPIC_API_KEY is set", () => {
    withEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const s = resolveProvider();
    expect(s.provider).toBe("anthropic");
    expect(s.model).toBe("claude-opus-4-8");
  });

  it("routes to OpenRouter when only OPENROUTER_API_KEY is set", () => {
    withEnv({ OPENROUTER_API_KEY: "sk-or-test", PR_REVIEW_MODEL: "anthropic/claude-sonnet-4.5" });
    const s = resolveProvider();
    expect(s.provider).toBe("openai-compatible");
    expect(s.baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(s.apiKey).toBe("sk-or-test");
  });

  it("accepts REPOMIND_* env vars, taking precedence over PR_REVIEW_*", () => {
    withEnv({
      OPENROUTER_API_KEY: "sk-or-test",
      REPOMIND_MODEL: "repomind-model",
      PR_REVIEW_MODEL: "legacy-model",
    });
    expect(resolveProvider().model).toBe("repomind-model");
  });

  it("routes to OpenAI when only OPENAI_API_KEY is set", () => {
    withEnv({ OPENAI_API_KEY: "sk-test", PR_REVIEW_MODEL: "gpt-4o" });
    const s = resolveProvider();
    expect(s.provider).toBe("openai-compatible");
    expect(s.baseUrl).toBe(OPENAI_BASE_URL);
  });

  it("supports arbitrary OpenAI-compatible endpoints via PR_REVIEW_BASE_URL", () => {
    withEnv({
      PR_REVIEW_BASE_URL: "https://my-gateway.example.com/v1",
      PR_REVIEW_API_KEY: "key-123",
      PR_REVIEW_MODEL: "my-model",
    });
    const s = resolveProvider();
    expect(s.provider).toBe("openai-compatible");
    expect(s.baseUrl).toBe("https://my-gateway.example.com/v1");
    expect(s.apiKey).toBe("key-123");
  });

  it("prefers Anthropic when multiple keys are present", () => {
    withEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", PR_REVIEW_MODEL: "claude-opus-4-8" });
    expect(resolveProvider().provider).toBe("anthropic");
  });

  it("honors an explicit PR_REVIEW_PROVIDER over key auto-detection", () => {
    withEnv({
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      PR_REVIEW_PROVIDER: "openai",
      PR_REVIEW_MODEL: "gpt-4o",
    });
    expect(resolveProvider().provider).toBe("openai-compatible");
  });

  it("requires a model for OpenAI-compatible providers", () => {
    withEnv({ OPENAI_API_KEY: "b" });
    expect(() => resolveProvider()).toThrow(/REPOMIND_MODEL/);
  });

  it("rejects unknown provider names", () => {
    withEnv({ PR_REVIEW_PROVIDER: "gemini" });
    expect(() => resolveProvider()).toThrow(/Unknown provider "gemini"/);
  });
});
