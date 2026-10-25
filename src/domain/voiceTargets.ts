import type { AgentInfo } from "./agent.model";
import type { TerminalMeta } from "./terminal.model";
import type { Workspace, WorkspaceGroup } from "./workspace.model";
import { agentKind, buildAgentLabels, type AgentLabel, type AgentLabelSources } from "./agentLabels";
import { normalizeVoiceText } from "./voiceCommands";

export interface VoiceTerminalMatch {
  workspace: Workspace;
  terminal: TerminalMeta;
}

export interface VoiceLabelSources {
  titles: Readonly<Record<string, string>>;
  names: AgentLabelSources["names"];
}

type TerminalPredicate = (terminal: TerminalMeta) => boolean;

function firstTerminalMatch(
  workspaces: readonly Workspace[],
  matches: TerminalPredicate,
): VoiceTerminalMatch | null {
  for (const workspace of workspaces) {
    const terminal = workspace.terminals.find(matches);
    if (terminal) return { workspace, terminal };
  }
  return null;
}

function namesTerminal(
  needle: string,
  titles: Readonly<Record<string, string>>,
  labels: Record<string, AgentLabel>,
): TerminalPredicate {
  return (candidate) => {
    const title = titles[candidate.id] ?? "";
    const command = candidate.command.trim();
    const label = labels[candidate.id];
    return [candidate.id, title, command, agentKind(command), label?.tag ?? "", label?.title ?? "", label?.name ?? ""]
      .some((value) => value && normalizeVoiceText(value) === needle);
  };
}

function overlapsTitle(needle: string, labels: Record<string, AgentLabel>): TerminalPredicate {
  return (candidate) => {
    const title = labels[candidate.id]?.title;
    return title ? normalizeVoiceText(title).includes(needle) || needle.includes(normalizeVoiceText(title)) : false;
  };
}

function firstTerminalOfWorkspace(workspaces: readonly Workspace[], needle: string): VoiceTerminalMatch | null {
  const workspace = workspaces.find(
    (candidate) =>
      normalizeVoiceText(candidate.id) === needle ||
      normalizeVoiceText(candidate.name) === needle,
  );
  const terminal = workspace?.terminals[0];
  return workspace && terminal ? { workspace, terminal } : null;
}

export function resolveVoiceTerminal(
  workspaces: readonly Workspace[],
  target: string,
  sources: VoiceLabelSources,
): VoiceTerminalMatch | null {
  const needle = normalizeVoiceText(target);
  if (!needle) return null;
  const labels = buildAgentLabels(workspaces, sources);
  return (
    firstTerminalMatch(workspaces, namesTerminal(needle, sources.titles, labels)) ??
    firstTerminalMatch(workspaces, overlapsTitle(needle, labels)) ??
    firstTerminalOfWorkspace(workspaces, needle)
  );
}

export function resolveVoiceGroup(groups: readonly WorkspaceGroup[], target: string): string | null {
  const needle = normalizeVoiceText(target);
  return groups.find(
    (group) =>
      normalizeVoiceText(group.id) === needle ||
      normalizeVoiceText(group.name) === needle,
  )?.id ?? null;
}

export function resolveVoiceAgent(agents: readonly AgentInfo[], target: string): AgentInfo | null {
  const needle = normalizeVoiceText(target);
  return agents.find(
    (candidate) =>
      candidate.available &&
      (normalizeVoiceText(candidate.id) === needle ||
        normalizeVoiceText(candidate.label) === needle),
  ) ?? null;
}

export function isVoiceModelError(message: unknown): boolean {
  const text = String(message ?? "").toLocaleLowerCase("pt-BR");
  return text.includes("model") || text.includes("modelo") || text.includes("whisper");
}
