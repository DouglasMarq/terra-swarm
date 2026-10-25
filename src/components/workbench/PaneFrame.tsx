import { useT } from "../../i18n";
import type { ReactNode } from "react";
import { EmptyPaneCell } from "./EmptyPaneCell";
import { SubTabLane } from "./SubTabLane";
import type {
  PaneFrameProps,
  SubTabLaneTab,
  WorkbenchLocation,
  WorkbenchTabRenderContext,
} from "./types";

type ExtendedTab = PaneFrameProps["projection"]["tabs"][number] & {
  isUnread?: boolean;
  status?: SubTabLaneTab["status"];
  isSuspended?: boolean;
};

function locationFor(
  paneFrame: PaneFrameProps,
): WorkbenchLocation {
  return {
    containerId: paneFrame.container.id,
    paneId: paneFrame.projection.pane.id,
    projectId: paneFrame.project?.id ?? null,
  };
}

function tabStatus(tab: ExtendedTab): SubTabLaneTab["status"] {
  if (tab.isSuspended) return "suspended";
  return tab.status ?? "running";
}

export function PaneFrame({
  projection,
  container,
  project,
  group,
  isActive = false,
  renderTab,
  onFocusTab,
  onNewTab,
  onDetachTab,
  onKillTab,
}: PaneFrameProps) {
  const translate = useT();
  const location = locationFor({ projection, container, project, group, renderTab });
  const activeTabId = projection.pane.activeTabId ?? projection.tabs[0]?.id ?? null;
  const laneTabs: SubTabLaneTab[] = projection.tabs.map((tab) => {
    const extended = tab as ExtendedTab;
    return {
      tab,
      isActive: tab.id === activeTabId,
      isUnread: extended.isUnread,
      status: tabStatus(extended),
    };
  });

  const hasTabs = projection.tabs.length > 0;
  const tabNodes: ReactNode[] = projection.tabs.map((tab) => {
    const isTabActive = tab.id === activeTabId;
    const context: WorkbenchTabRenderContext = {
      tab,
      pane: projection.pane,
      container,
      project,
      group,
      isActive: isTabActive,
      isHidden: !isTabActive,
    };
    return (
      <div
        className="terra-pane-tab-surface"
        key={tab.id}
        aria-hidden={!isTabActive}
        data-tab-id={tab.id}
        data-active={isTabActive}
      >
        {renderTab(context)}
      </div>
    );
  });

  return (
    <section
      className="terra-pane-frame"
      data-pane-id={projection.pane.id}
      data-active={isActive}
      aria-label={translate("workbench.pane", { name: projection.pane.id })}
    >
      {hasTabs && projection.tabs.length > 1 ? (
        <SubTabLane
          tabs={laneTabs}
          onFocusTab={(tabId) => onFocusTab?.(tabId, location)}
          onNewTab={() => onNewTab?.(location)}
          onDetachTab={(tabId) => onDetachTab?.(tabId, location)}
          onKillTab={(tabId) => onKillTab?.(tabId, location)}
        />
      ) : null}
      <div className="terra-pane-frame__body">
        <div className="terra-pane-frame__surface">
          {projection.tabs.length > 0 ? (
            <div className="terra-pane-tab-surfaces">{tabNodes}</div>
          ) : (
            <EmptyPaneCell
              paneId={projection.pane.id}
              projectName={project?.name}
              onNewTab={() => onNewTab?.(location)}
            />
          )}
        </div>
      </div>
    </section>
  );
}
