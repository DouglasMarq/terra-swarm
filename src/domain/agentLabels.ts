import type { Workspace } from "../types";

/**
 * How an agent is identified everywhere in the UI (sidebar, pane header,
 * fleet, notifications, voice target).
 *
 * - `kind` is the executable ("claude", "codex", "shell").
 * - `tag` disambiguates agents of the same kind inside one project: a single
 *   claude is "claude"; three are "claude 1", "claude 2", "claude 3". When the
 *   user (or auto-naming) gave the agent a name, the tag is "Lyra · claude".
 * - `title` is the task title the agent set through OSC, cleaned up.
 * - `primary` is what rows show first: the task title when there is one,
 *   otherwise the name, otherwise the tag.
 */
export interface AgentLabel {
  terminalId: string;
  workspaceId: string;
  kind: string;
  tag: string;
  title: string | null;
  name: string | null;
  primary: string;
}

export interface AgentLabelSources {
  titles?: Readonly<Record<string, string | undefined>>;
  names?: Readonly<Record<string, string | null | undefined>>;
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "pwsh", "powershell", "nu", "cmd"]);

/** First token of the command, without its path. Shells collapse to "shell". */
export function agentKind(command: string | null | undefined): string {
  const first = (command ?? "").trim().split(/\s+/)[0] ?? "";
  const base = first.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? "";
  if (!base) return "shell";
  const lower = base.toLowerCase();
  return SHELLS.has(lower) ? "shell" : lower;
}

// Spinner glyphs, bullets and status marks agents prepend to OSC titles.
const TITLE_DECORATION = /^[\s⠀-⣿✀-➿☀-⛿■-◿•·*✳✻✶✢·⠂⠐]+/u;

/**
 * Turns a raw OSC title into a task title, or null when it carries no task
 * (it is just the command, the kind, a path, or the agent's product name).
 */
export function cleanAgentTitle(raw: string | null | undefined, command: string, kind: string): string | null {
  if (!raw) return null;
  const title = raw.replace(TITLE_DECORATION, "").trim();
  if (!title) return null;
  const lower = title.toLowerCase();
  if (lower === kind || lower === command.trim().toLowerCase()) return null;
  if (/^(claude code|codex|opencode|kimi|gemini|aider)$/i.test(title)) return null;
  if (/^[~/]/.test(title) || /^[a-z]:\\/i.test(title)) return null;
  if (/^[\w.-]+@[\w.-]+:/.test(title)) return null; // user@host:path from shells
  return title;
}

export function buildAgentLabels(
  workspaces: readonly Workspace[],
  sources: AgentLabelSources = {},
): Record<string, AgentLabel> {
  const result: Record<string, AgentLabel> = {};
  for (const workspace of workspaces) {
    const kinds = workspace.terminals.map((terminal) => agentKind(terminal.command));
    const totals = new Map<string, number>();
    kinds.forEach((kind) => totals.set(kind, (totals.get(kind) ?? 0) + 1));
    const seen = new Map<string, number>();
    workspace.terminals.forEach((terminal, index) => {
      const kind = kinds[index];
      const ordinal = (seen.get(kind) ?? 0) + 1;
      seen.set(kind, ordinal);
      const numbered = (totals.get(kind) ?? 0) > 1 ? `${kind} ${ordinal}` : kind;
      const name = sources.names?.[terminal.id]?.trim() || null;
      const title = cleanAgentTitle(sources.titles?.[terminal.id], terminal.command, kind);
      const tag = name ? `${name} · ${kind}` : numbered;
      result[terminal.id] = {
        terminalId: terminal.id,
        workspaceId: workspace.id,
        kind,
        tag,
        title,
        name,
        primary: title ?? name ?? numbered,
      };
    });
  }
  return result;
}

/** One-line label: the primary text plus the tag, without repeating either
 * ("Animações · claude 2", "Lyra · claude", "claude"). */
export function agentLabelText(label: Pick<AgentLabel, "primary" | "tag">): string {
  if (label.tag.split(" · ").includes(label.primary) || label.tag === label.primary) return label.tag;
  return `${label.primary} · ${label.tag}`;
}

/** Fallback for ids that are not (or no longer) in the workspace list. */
export function fallbackAgentLabel(terminalId: string, workspaceId = ""): AgentLabel {
  return { terminalId, workspaceId, kind: "agente", tag: "agente", title: null, name: null, primary: "agente" };
}
