import { describe, expect, it } from "vitest";
import { getFileInfo, searchSymbols } from "../src/query.js";
import type { CodemapIndex } from "../src/types.js";

const index: CodemapIndex = {
  version: 1,
  generatedAt: "2026-07-06T00:00:00Z",
  files: {
    "src/auth.ts": {
      hash: "a",
      summary: "Session auth.",
      symbols: ["export function login(user: string)", "export function logout()"],
      imports: ["src/db.ts"],
    },
    "src/db.ts": {
      hash: "b",
      summary: "DB pool.",
      symbols: ["export const pool"],
      imports: [],
    },
    "src/routes/login.ts": {
      hash: "c",
      summary: "Login route.",
      symbols: ["export const handler"],
      imports: ["src/auth.ts"],
    },
  },
};

describe("searchSymbols", () => {
  it("matches symbols case-insensitively and ranks symbol hits above path hits", () => {
    const results = searchSymbols(index, "LOGIN");
    expect(results.map((r) => r.path)).toEqual(["src/auth.ts", "src/routes/login.ts"]);
    expect(results[0].symbols).toEqual(["export function login(user: string)"]);
  });

  it("returns empty for no matches", () => {
    expect(searchSymbols(index, "nonexistent")).toEqual([]);
  });
});

describe("getFileInfo", () => {
  it("includes importers computed from the reverse import graph", () => {
    const info = getFileInfo(index, "src/auth.ts");
    expect(info?.importers).toEqual(["src/routes/login.ts"]);
    expect(info?.imports).toEqual(["src/db.ts"]);
  });

  it("returns null for unknown files", () => {
    expect(getFileInfo(index, "nope.ts")).toBeNull();
  });
});
