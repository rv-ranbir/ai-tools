import { describe, expect, it } from "vitest";
import { selectContext } from "../src/codemap/graph.js";
import type { CodemapIndex } from "../src/types.js";

const index: CodemapIndex = {
  version: 1,
  generatedAt: "2026-07-06T00:00:00Z",
  files: {
    "src/auth/session.ts": {
      hash: "a",
      summary: "Session creation and validation.",
      symbols: ["export function validate(token: Token)"],
      imports: ["src/auth/token.ts"],
    },
    "src/auth/token.ts": {
      hash: "b",
      summary: "Token encoding/decoding.",
      symbols: ["export function decode(raw: string): Token"],
      imports: [],
    },
    "src/api/login.ts": {
      hash: "c",
      summary: "Login endpoint; calls session.validate.",
      symbols: ["export const loginHandler"],
      imports: ["src/auth/session.ts"],
    },
    "src/api/logout.ts": {
      hash: "d",
      summary: "Logout endpoint.",
      symbols: ["export const logoutHandler"],
      imports: ["src/auth/session.ts"],
    },
    "src/unrelated.ts": {
      hash: "e",
      summary: "Nothing to do with auth.",
      symbols: [],
      imports: [],
    },
  },
};

describe("selectContext", () => {
  it("selects importers first, then imports, then the changed file itself", () => {
    const { entries } = selectContext(index, ["src/auth/session.ts"], 100_000);
    const relations = entries.map((e) => `${e.relation}:${e.path}`);
    expect(relations).toEqual([
      "importer:src/api/login.ts",
      "importer:src/api/logout.ts",
      "import:src/auth/token.ts",
      "changed:src/auth/session.ts",
    ]);
    expect(relations.join()).not.toContain("unrelated");
  });

  it("respects the token budget", () => {
    const full = selectContext(index, ["src/auth/session.ts"], 100_000);
    const tight = selectContext(index, ["src/auth/session.ts"], 30);
    expect(tight.entries.length).toBeLessThan(full.entries.length);
  });

  it("returns nothing for files unknown to the index", () => {
    const { entries, rendered } = selectContext(index, ["src/brand-new.ts"], 100_000);
    expect(entries).toEqual([]);
    expect(rendered).toBe("");
  });

  it("renders summaries and symbols into the context text", () => {
    const { rendered } = selectContext(index, ["src/auth/session.ts"], 100_000);
    expect(rendered).toContain("Login endpoint; calls session.validate.");
    expect(rendered).toContain("export function decode(raw: string): Token");
  });
});
