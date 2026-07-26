export const BUILTIN_REDACT_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(sk|ghp|gho|ghu|ghs|ghr|glpat)-[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(password|api[_-]?key|secret|token)\b\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
];

export function compileRedactPatterns(sources: string[]): RegExp[] {
  return sources.map((src, i) => {
    try {
      return new RegExp(src, "g");
    } catch (e) {
      throw new Error(
        `Invalid redact_patterns[${i}]: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
}

export function redactSecrets(text: string, extra: RegExp[] = []): string {
  let out = text;
  for (const re of [...BUILTIN_REDACT_PATTERNS, ...extra]) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    out = out.replace(new RegExp(re.source, flags), "[REDACTED]");
  }
  return out;
}
