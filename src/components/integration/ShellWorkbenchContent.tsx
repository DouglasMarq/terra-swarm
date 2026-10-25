import { LayoutGrid } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../../i18n";
import type { WorkspaceSnapshotV2 } from "../../domain/workspace.model";
import { useOrchestrationStore } from "../../stores/orchestrationStore";
import type { WorkbenchLocation, WorkbenchTabRenderer } from "../workbench/types";
import { WorkspaceWorkbench } from "./lazySurfaces";

export interface ShellWorkbenchActions {
  onFocusTerminalTab: (ptyId: string, location?: WorkbenchLocation) => void;
  onFocus: (id: string) => void;
  onNewWorkspace: () => void;
  onNewAgent: (workspaceId: string, paneId?: string | null) => void;
  onQuickNewAgent?: (workspaceId: string) => void;
  onDetach: (id: string) => void;
  onKill: (id: string) => void;
  onHideWorkspace: (id: string) => void;
  onHideContainer?: (containerId: string) => void;
}

interface ShellWorkbenchContentProps {
  source: WorkspaceSnapshotV2 | null;
  snapshot: WorkspaceSnapshotV2 | null;
  activeId: string | null;
  renderTab: WorkbenchTabRenderer;
  actions: ShellWorkbenchActions;
}

function WorkbenchEmpty({ onNewWorkspace }: { onNewWorkspace: () => void }) {
  const t = useT();
  return (
    <div className="terra-workbench__empty">
      <LayoutGrid size={20} />
      <strong>{t("shell.workbenchEmpty")}</strong>
      <button type="button" className="terra-button" onClick={onNewWorkspace}>{t("shell.newWorkspace")}</button>
    </div>
  );
}

function WorkbenchNotLoaded() {
  const t = useT();
  return <div className="terra-workbench__empty"><LayoutGrid size={20} /><strong>{t("shell.workbenchNotLoaded")}</strong></div>;
}

export function ShellWorkbenchContent({ source, snapshot, activeId, renderTab, actions }: ShellWorkbenchContentProps) {
  const orchestration = useOrchestrationStore(useShallow((state) => ({
    setContainerState: state.setContainerState,
    setContainerCollapsed: state.setContainerCollapsed,
    setContainerFullscreen: state.setContainerFullscreen,
    setContainerActivePane: state.setContainerActivePane,
    setWorkspaceLayout: state.setWorkspaceLayout,
  })));
  if (!source) return <WorkbenchNotLoaded />;
  const tabPtyId = (tabId: string) => snapshot?.tabs.find((candidate) => candidate.id === tabId)?.ptyId ?? null;
  const workspaceFor = (location: WorkbenchLocation) => location.projectId ?? activeId ?? "";
  const onFocusTab = (tabId: string, location: WorkbenchLocation) => {
    if (location) orchestration.setContainerActivePane(location.containerId, location.paneId);
    const ptyId = tabPtyId(tabId);
    if (ptyId) actions.onFocusTerminalTab(ptyId, location);
    else actions.onFocus(tabId);
  };
  const onDetachTab = (tabId: string) => {
    const ptyId = tabPtyId(tabId);
    if (ptyId) actions.onDetach(ptyId);
  };
  const onKillTab = (tabId: string) => {
    const ptyId = tabPtyId(tabId);
    if (ptyId) actions.onKill(ptyId);
  };
  const onCollapseContainer = (containerId: string, collapsed: boolean) => {
    if (collapsed) orchestration.setContainerFullscreen(containerId, false);
    orchestration.setContainerCollapsed(containerId, collapsed);
  };
  const hideContainerProject = (containerId: string) => {
    const container = snapshot?.containers.find((candidate) => candidate.id === containerId);
    if (container?.projectId) actions.onHideWorkspace(container.projectId);
  };
  const { onQuickNewAgent } = actions;
  return (
    <WorkspaceWorkbench
      source={source}
      renderTab={renderTab}
      onNewContainer={actions.onNewWorkspace}
      onFocusTab={onFocusTab}
      onNewTab={(location) => actions.onNewAgent(workspaceFor(location), location.paneId)}
      onQuickNewTab={onQuickNewAgent ? (location) => onQuickNewAgent(workspaceFor(location)) : undefined}
      onDetachTab={onDetachTab}
      onKillTab={onKillTab}
      onCollapseContainer={onCollapseContainer}
      onFullscreenContainer={orchestration.setContainerFullscreen}
      onLayoutChange={({ containerId, layout }) => orchestration.setContainerState(containerId, { layout })}
      onWorkspaceLayoutChange={orchestration.setWorkspaceLayout}
      onHideContainer={actions.onHideContainer ?? hideContainerProject}
      emptyState={<WorkbenchEmpty onNewWorkspace={actions.onNewWorkspace} />}
    />
  );
}
