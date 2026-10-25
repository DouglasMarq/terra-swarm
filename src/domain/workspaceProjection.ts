import type { Group, Workspace, WorkspaceGroup, WorkspaceSnapshotV2 } from "./workspace.model";
import { uniqueStrings } from "../lib/collections/uniqueStrings";
import { asRecord } from "../lib/records/records";
import { DEFAULT_WORKSPACE_LAYOUT, mergeWorkspaceLayout, normalizeLayout } from "./migration/workspaceLayout";
import { mergeWorkspaceSnapshot } from "./migration/snapshotMerge";

function sourceGroupLayout(source: WorkspaceGroup): ReturnType<typeof normalizeLayout> {
  const layout = asRecord(source).layout;
  const mode = typeof layout === "object" ? layout : {
    mode: source.layoutMode ?? DEFAULT_WORKSPACE_LAYOUT.mode,
  };
  return normalizeLayout(mode);
}

function toDomainGroups(
  sourceGroups: readonly WorkspaceGroup[],
  snapshot: WorkspaceSnapshotV2,
  workspaces: readonly Workspace[],
  previousGroups: readonly Group[] = [],
): Group[] {
  const projectIds = new Set(snapshot.projects.map((project) => project.id));
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const projectsByGroup = new Map<string, string[]>();
  for (const project of snapshot.projects) {
    if (!project.groupId || !projectIds.has(project.id)) continue;
    const ids = projectsByGroup.get(project.groupId) ?? [];
    ids.push(project.id);
    projectsByGroup.set(project.groupId, ids);
  }
  for (const workspace of workspaces) {
    const groupId = workspace.groupId ?? null;
    if (!groupId || !projectIds.has(workspace.id)) continue;
    const ids = projectsByGroup.get(groupId) ?? [];
    ids.push(workspace.id);
    projectsByGroup.set(groupId, ids);
  }

  const effectiveGroups = sourceGroups.length > 0 ? sourceGroups : previousGroups;
  const previousById = new Map(previousGroups.map((group) => [group.id, group]));
  return effectiveGroups
    .filter((source) => Boolean(source.id))
    .map((source): Group => {
      const projectIdsForGroup = uniqueStrings([
        ...source.projectIds.filter((projectId) => {
          const workspace = workspaceById.get(projectId);
          return !workspace || workspace.groupId === undefined || workspace.groupId === source.id;
        }),
        ...(projectsByGroup.get(source.id) ?? []),
      ]).filter((id) => projectIds.has(id));
      const layout = sourceGroupLayout(source);
      const previous = previousById.get(source.id);
      const parentGroupId = source.parentGroupId || null;
      return {
        id: source.id,
        name: source.name.trim() || source.id,
        projectIds: projectIdsForGroup,
        parentGroupId,
        collapsed: Boolean(source.collapsed),
        suspended: Boolean(source.suspended),
        layout: mergeWorkspaceLayout(
          previous?.layout,
          { ...layout, itemIds: projectIdsForGroup },
          new Set(projectIdsForGroup),
          DEFAULT_WORKSPACE_LAYOUT,
        ),
        ...(("archived" in source && source.archived) ? { archived: true } : {}),
      };
    });
}

export function deriveSnapshot(
  workspaces: readonly Workspace[],
  sourceGroups: readonly WorkspaceGroup[],
  visibility: Record<string, boolean>,
  previous: WorkspaceSnapshotV2 | null,
): { snapshot: WorkspaceSnapshotV2; groups: Group[] } {
  const snapshot = mergeWorkspaceSnapshot(workspaces, previous, {
    containerVisibility: visibility,
  });
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

  for (const project of snapshot.projects) {
    const workspace = workspaceById.get(project.id);
    project.groupId =
      workspace && workspace.groupId !== undefined
        ? workspace.groupId
        : project.groupId ?? null;
    project.collapsed = workspace?.collapsed ?? project.collapsed;
    project.archived = workspace?.archived ?? project.archived;
  }

  for (const container of snapshot.containers) {
    const visible = visibility[container.id] ?? true;
    container.visible = visible;
    container.closed = !visible;
  }

  const groups = toDomainGroups(sourceGroups, snapshot, workspaces, previous?.groups ?? snapshot.groups);
  snapshot.groups = groups;
  snapshot.activeGroupId = groups.some((group) => group.id === snapshot.activeGroupId)
    ? snapshot.activeGroupId
    : null;
  return { snapshot, groups };
}
