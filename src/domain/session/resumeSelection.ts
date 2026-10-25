import type { TerminalMeta } from "../terminal.model";
import type { Workspace, WorkspaceGroup } from "../workspace.model";

export function suspendedGroupIds(
  groups: readonly Pick<WorkspaceGroup, "id" | "suspended">[],
): ReadonlySet<string> {
  return new Set(
    groups
      .filter((group) => group.suspended === true && group.id.trim().length > 0)
      .map((group) => group.id),
  );
}

export function isTerminalSuspended(
  workspace: Pick<Workspace, "groupId">,
  terminal: Pick<TerminalMeta, "suspended">,
  suspendedGroups: ReadonlySet<string>,
): boolean {
  return (
    terminal.suspended === true ||
    (workspace.groupId != null && suspendedGroups.has(workspace.groupId))
  );
}
