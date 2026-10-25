import type { TerminalMeta } from "../terminal.model";
import type { Workspace, WorkspaceGroup } from "../workspace.model";

export function suspendedGroupIds(
  groups: readonly Pick<WorkspaceGroup, "id" | "isSuspended">[],
): ReadonlySet<string> {
  return new Set(
    groups
      .filter((group) => group.isSuspended === true && group.id.trim().length > 0)
      .map((group) => group.id),
  );
}

export function isTerminalSuspended(
  workspace: Pick<Workspace, "groupId">,
  terminal: Pick<TerminalMeta, "isSuspended">,
  suspendedGroups: ReadonlySet<string>,
): boolean {
  return (
    terminal.isSuspended === true ||
    (workspace.groupId != null && suspendedGroups.has(workspace.groupId))
  );
}
