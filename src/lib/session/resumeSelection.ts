import type { TerminalMeta, Workspace, WorkspaceGroup } from "../../types";

/**
 * Builds the group lookup used by startup resume. A group can reference a
 * project from either side of the migration (the workspace's groupId or the
 * group's projectIds), so callers should use this normalized set instead of
 * checking only one representation.
 */
export function suspendedGroupIds(
  groups: readonly Pick<WorkspaceGroup, "id" | "suspended">[],
): ReadonlySet<string> {
  return new Set(
    groups
      .filter((group) => group.suspended === true && group.id.trim().length > 0)
      .map((group) => group.id),
  );
}

/**
 * Suspended metadata is an intentional lifecycle state. It must not be
 * converted into an implicit startup-resume item, including after importing a
 * snapshot where every session is marked suspended by the backend.
 */
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
