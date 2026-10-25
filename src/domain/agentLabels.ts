import type { Workspace } from "./workspace.model";

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

export function agentKind(command: string | null | undefined): string {
  const first = (command ?? "").trim().split(/\s+/)[0] ?? "";
  const base = first.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? "";
  if (!base) return "shell";
  const lower = base.toLowerCase();
  return SHELLS.has(lower) ? "shell" : lower;
}

const LEADING_STATUS_GLYPHS = /^[\s⠀-⣿✀-➿☀-⛿■-◿•·*✳✻✶✢·⠂⠐]+/u;
const SHELL_PROMPT_TITLE = /^[\w.-]+@[\w.-]+:/;

export function cleanAgentTitle(raw: string | null | undefined, command: string, kind: string): string | null {
  if (!raw) return null;
  const title = raw.replace(LEADING_STATUS_GLYPHS, "").trim();
  if (!title) return null;
  const lower = title.toLowerCase();
  if (lower === kind || lower === command.trim().toLowerCase()) return null;
  if (/^(claude code|codex|opencode|kimi|gemini|aider)$/i.test(title)) return null;
  if (/^[~/]/.test(title) || /^[a-z]:\\/i.test(title)) return null;
  if (SHELL_PROMPT_TITLE.test(title)) return null;
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

export function agentLabelText(label: Pick<AgentLabel, "primary" | "tag">): string {
  if (label.tag.split(" · ").includes(label.primary) || label.tag === label.primary) return label.tag;
  return `${label.primary} · ${label.tag}`;
}

