import { migrateLegacyWorkspaces } from "../../domain/migration";
import { byId } from "../../domain/selectors";
import { uniqueStrings } from "../../lib/collections/uniqueStrings";
import type {
  Group,
  Pane,
  Project,
  TerminalTab,
  WorkspaceContainer,
  WorkspaceSnapshotV2,
} from "../../types";
import type {
  WorkbenchContainerProjection,
  WorkbenchPaneProjection,
  WorkbenchProjection,
  WorkbenchSource,
} from "./types";


function isSnapshot(source: WorkbenchSource): source is WorkspaceSnapshotV2 {
  return !Array.isArray(source) && "version" in source && source.version === 2;
}

export function toWorkbenchSnapshot(source: WorkbenchSource): WorkspaceSnapshotV2 {
  return isSnapshot(source) ? source : migrateLegacyWorkspaces(source);
}

function projectForContainer(
  snapshot: WorkspaceSnapshotV2,
  container: WorkspaceContainer,
): Project | null {
  return byId(snapshot.projects, container.projectId);
}

function groupForProject(snapshot: WorkspaceSnapshotV2, project: Project | null): Group | null {
  return byId(snapshot.groups, project?.groupId);
}

function paneIdsForContainer(
  container: WorkspaceContainer,
  project: Project | null,
): string[] {
  const declared = uniqueStrings(container.paneIds);
  if (declared.length > 0) return declared;

  // Legacy snapshots can have a project-level pane list without copying it
  // onto its sole container. This fallback keeps the projection lossless.
  if (project && project.containerIds.length <= 1) return uniqueStrings(project.paneIds);
  return [];
}

function tabsForPane(snapshot: WorkspaceSnapshotV2, pane: Pane): TerminalTab[] {
  const tabsById = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  return uniqueStrings(pane.tabIds)
    .map((tabId) => tabsById.get(tabId))
    .filter((tab): tab is TerminalTab => tab !== undefined);
}

function paneProjection(
  snapshot: WorkspaceSnapshotV2,
  paneId: string,
): WorkbenchPaneProjection | null {
  const pane = byId(snapshot.panes, paneId);
  return pane ? { pane, tabs: tabsForPane(snapshot, pane) } : null;
}

function containerProjection(
  snapshot: WorkspaceSnapshotV2,
  container: WorkspaceContainer,
): WorkbenchContainerProjection {
  const project = projectForContainer(snapshot, container);
  const group = groupForProject(snapshot, project);
  const panes = paneIdsForContainer(container, project)
    .map((paneId) => paneProjection(snapshot, paneId))
    .filter((pane): pane is WorkbenchPaneProjection => pane !== null);
  return { container, project, group, panes };
}

/**
 * Projects normalized domain data into the visual workbench hierarchy.
 *
 * The projection never mutates the source and deliberately keeps hidden and
 * collapsed containers in the result. React can therefore hide a surface
 * without unmounting its terminal render trees or terminating their PTYs.
 */
export function projectWorkbench(source: WorkbenchSource): WorkbenchProjection {
  const snapshot = toWorkbenchSnapshot(source);
  const containers = snapshot.containers.map((container) =>
    containerProjection(snapshot, container),
  );
  return { source: snapshot, containers };
}
