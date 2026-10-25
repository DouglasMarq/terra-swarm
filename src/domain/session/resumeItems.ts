import type { ResumeItem } from "../terminal.model";
import type { Workspace } from "../workspace.model";
import { agentKind } from "../agentLabels";
import { profileForCommand, resolveResumeCommand } from "../agentProfiles";

export function resumeCommandFor(command: string): string {
  return resolveResumeCommand(profileForCommand(command), command);
}

export function resumeItemFor(workspace: Workspace, terminal: Workspace["terminals"][number]): ResumeItem {
  return {
    terminalId: terminal.id,
    wsId: workspace.id,
    wsName: workspace.name,
    cwd: workspace.cwd,
    command: terminal.command,
    agentId: agentKind(terminal.command),
    resumeCommand: resumeCommandFor(terminal.command),
  };
}
