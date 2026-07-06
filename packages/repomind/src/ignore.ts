export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.git/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.map",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/.repomind/**",
  "**/.pr-review/**",
];

/** Minimal glob matcher supporting **, * and ? — enough for ignore patterns. */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const rx = globToRegExp(pattern);
  return rx.test(normalized) || rx.test(`/${normalized}`);
}

/** True when the path matches DEFAULT_IGNORE or any of the extra patterns. */
export function isIgnored(filePath: string, extraPatterns: string[] = []): boolean {
  return [...DEFAULT_IGNORE, ...extraPatterns].some((p) => matchesGlob(filePath, p));
}

function globToRegExp(pattern: string): RegExp {
  let rx = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // "**/" matches zero or more path segments; bare "**" matches anything.
        if (pattern[i + 2] === "/") {
          rx += "(?:[^/]*/)*";
          i += 3;
        } else {
          rx += ".*";
          i += 2;
        }
      } else {
        rx += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      rx += "[^/]";
      i += 1;
    } else {
      rx += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${rx}$`);
}
