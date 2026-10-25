import { describe, expect, it } from "vitest";
import { parsePatch, suggestTitle } from "./diffModel";

const PATCH = `diff --git a/app/readme.txt b/app/readme.txt
index ce01362..94954ab 100644
--- a/app/readme.txt
+++ b/app/readme.txt
@@ -1,2 +1,3 @@
 hello
-old
+new
+world
diff --git a/app/notes.md b/app/notes.md
new file mode 100644
index 0000000..422c2b7
--- /dev/null
+++ b/app/notes.md
@@ -0,0 +1,2 @@
+a
+b
diff --git a/logo.png b/logo.png
Binary files /dev/null and b/logo.png differ
`;

describe("parsePatch", () => {
  it("Given a patch, when parsing it, then it is split into numbered lines per file", () => {
    const [readme, notes, logo] = parsePatch(PATCH);
    expect(readme.path).toBe("app/readme.txt");
    expect(readme.lines.map((line) => [line.kind, line.text, line.oldLine, line.newLine])).toEqual([
      ["hunk", "@@ -1,2 +1,3 @@", null, null],
      ["context", "hello", 1, 1],
      ["del", "old", 2, null],
      ["add", "new", null, 2],
      ["add", "world", null, 3],
    ]);
    expect(notes.path).toBe("app/notes.md");
    expect(notes.lines[0]).toMatchObject({ kind: "meta", text: "new file mode 100644" });
    expect(notes.lines.filter((line) => line.kind === "add")).toHaveLength(2);
    expect(logo.isBinary).toBe(true);
  });

  it("Given an empty patch, when parsing it, then no section is returned", () => {
    expect(parsePatch("")).toEqual([]);
  });
});

describe("suggestTitle", () => {
  it("Given an agent summary or only a branch, when suggesting a title, then the summary is used, else the branch", () => {
    expect(suggestTitle("terra/t-1", "  Fix the\nlogin bug ")).toBe("Fix the login bug");
    expect(suggestTitle("terra/t-1", "")).toBe("Changes from terra/t-1");
    expect(suggestTitle("b", "x".repeat(100))).toHaveLength(72);
  });
});
