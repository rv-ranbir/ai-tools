import { describe, expect, it } from "vitest";
import { parseDiff, renderDiffForPrompt } from "../src/diff/parse.js";

const SIMPLE_DIFF = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1111111..2222222 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -40,7 +40,8 @@ export function validate(token: Token) {
   const now = Date.now();
-  if (token.exp < now) {
+  if (token.exp <= now) {
+    logExpiry(token);
     return null;
   }
   return token;
`;

const MULTI_FILE_DIFF = `diff --git a/a.txt b/a.txt
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/a.txt
@@ -0,0 +1,2 @@
+first
+second
diff --git a/b.txt b/b.txt
deleted file mode 100644
index 1111111..0000000
--- a/b.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
index 1111111..2222222 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,2 +1,2 @@
-const x = 1
+const x = 2
 const y = 3
\\ No newline at end of file
`;

describe("parseDiff", () => {
  it("parses a single-file modification with correct changed lines", () => {
    const files = parseDiff(SIMPLE_DIFF);
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f.path).toBe("src/auth/session.ts");
    expect(f.status).toBe("modified");
    expect(f.hunks).toHaveLength(1);
    // Hunk starts at new line 40 (context), so "+" lines land on 41 and 42.
    expect(f.changedLines).toEqual([41, 42]);
  });

  it("parses added, deleted and renamed files", () => {
    const files = parseDiff(MULTI_FILE_DIFF);
    expect(files).toHaveLength(3);

    const [added, deleted, renamed] = files;
    expect(added.status).toBe("added");
    expect(added.path).toBe("a.txt");
    expect(added.changedLines).toEqual([1, 2]);

    expect(deleted.status).toBe("deleted");
    expect(deleted.path).toBe("b.txt");
    expect(deleted.changedLines).toEqual([]);

    expect(renamed.status).toBe("renamed");
    expect(renamed.path).toBe("new-name.ts");
    expect(renamed.oldPath).toBe("old-name.ts");
    expect(renamed.changedLines).toEqual([1]);
  });

  it("handles hunk headers without an explicit line count", () => {
    const diff = `diff --git a/x b/x
index 1..2 100644
--- a/x
+++ b/x
@@ -1 +1 @@
-old
+new
`;
    const files = parseDiff(diff);
    expect(files[0].hunks[0].newLines).toBe(1);
    expect(files[0].changedLines).toEqual([1]);
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("renderDiffForPrompt", () => {
  it("annotates added lines with new-file line numbers", () => {
    const [file] = parseDiff(SIMPLE_DIFF);
    const rendered = renderDiffForPrompt(file);
    expect(rendered).toContain("### MODIFIED: src/auth/session.ts");
    expect(rendered).toContain("   41 + ");
    expect(rendered).toContain("   42 + ");
    // Removed lines carry no new-file number.
    expect(rendered).toMatch(/ {6}- +if \(token\.exp < now\)/);
  });
});
