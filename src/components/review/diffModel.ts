/** One line of a unified diff, classified for rendering. */
export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk" | "meta";
  text: string;
  /** Line numbers in the old and new file, when the line has one. */
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffFileSection {
  path: string;
  lines: DiffLine[];
  binary: boolean;
}

const NEW_PATH_PREFIX = "+++ b/";
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function pathOf(header: string): string {
  // "diff --git a/x b/x"; a new file diffed against /dev/null has "a//dev/null"-style names.
  const match = /^diff --git a\/(.*) b\/(.*)$/.exec(header);
  if (match) return match[2];
  return header.replace(/^diff --git /, "");
}

/** Split a `git diff` patch into per-file sections with numbered lines. */
export function parsePatch(patch: string): DiffFileSection[] {
  const sections: DiffFileSection[] = [];
  let current: DiffFileSection | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    if (text.startsWith("diff --git ")) {
      current = { path: pathOf(text), lines: [], binary: false };
      sections.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    const hunk = HUNK.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      current.lines.push({ kind: "hunk", text, oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk) {
      if (text.startsWith(NEW_PATH_PREFIX)) current.path = text.slice(NEW_PATH_PREFIX.length);
      if (text.startsWith("Binary files")) current.binary = true;
      if (text.startsWith("new file") || text.startsWith("deleted file") || text.startsWith("rename ") || text.startsWith("Binary files")) {
        current.lines.push({ kind: "meta", text, oldLine: null, newLine: null });
      }
      continue;
    }
    if (text.startsWith("+")) {
      current.lines.push({ kind: "add", text: text.slice(1), oldLine: null, newLine: newLine++ });
    } else if (text.startsWith("-")) {
      current.lines.push({ kind: "del", text: text.slice(1), oldLine: oldLine++, newLine: null });
    } else if (text.startsWith("\\")) {
      current.lines.push({ kind: "meta", text, oldLine: null, newLine: null });
    } else if (text.length > 0 || current.lines.length > 0) {
      current.lines.push({ kind: "context", text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  // A trailing newline in the patch leaves one empty context line behind.
  for (const section of sections) {
    const last = section.lines[section.lines.length - 1];
    if (last?.kind === "context" && last.text === "") section.lines.pop();
  }
  return sections;
}

/** Longest suggested commit message / PR title, ellipsis included. */
const MAX_SUGGESTED_TITLE_CHARS = 72;

/** Default commit message / PR title from what the agent was doing. */
export function suggestTitle(fallbackName: string, summary: string | null | undefined): string {
  const text = (summary ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > MAX_SUGGESTED_TITLE_CHARS ? `${text.slice(0, MAX_SUGGESTED_TITLE_CHARS - 1)}…` : text;
  return `Changes from ${fallbackName}`;
}
