import { describe, expect, it } from "vitest";
import { compileRedactPatterns, redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts AWS access key ids", () => {
    const out = redactSecrets("key=AKIAIOSFODNN7EXAMPLE rest");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts sk- style tokens", () => {
    const out = redactSecrets("Authorization: Bearer sk-abc123DEF456ghi789jkl");
    expect(out).not.toMatch(/sk-[A-Za-z0-9]+/);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts PEM blocks", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";
    expect(redactSecrets(pem)).not.toContain("BEGIN PRIVATE KEY");
    expect(redactSecrets(pem)).toContain("[REDACTED]");
  });

  it("applies custom patterns after built-ins", () => {
    const custom = compileRedactPatterns(["SECRET_WORD_[0-9]+"]);
    expect(redactSecrets("x SECRET_WORD_99 y", custom)).toBe("x [REDACTED] y");
  });

  it("compileRedactPatterns throws on bad regex", () => {
    expect(() => compileRedactPatterns(["[unclosed"])).toThrow(/redact_patterns/);
  });
});
