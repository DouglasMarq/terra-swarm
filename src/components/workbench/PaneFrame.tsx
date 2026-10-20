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
  unread?: boolean;
  status?: SubTabLaneTab["status"];
  suspended?: boolean;
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
  if (tab.suspended) return "suspended";
  return tab.status ?? "running";
}

export function PaneFrame({
  projection,
  container,
  project,
  group,
  active = false,
  renderTab,
  onFocusTab,
  onNewTab,
  onDetachTab,
  onKillTab,
}: PaneFrameProps) {
  const t = useT();
  const location = locationFor({ projection, container, project, group, renderTab });
  const activeTabId = projection.pane.activeTabId ?? projection.tabs[0]?.id ?? null;
  const laneTabs: SubTabLaneTab[] = projection.tabs.map((tab) => {
    const extended = tab as ExtendedTab;
    return {
      tab,
      active: tab.id === activeTabId,
      unread: extended.unread,
      status: tabStatus(extended),
    };
  });

  const hasTabs = projection.tabs.length > 0;
  const tabNodes: ReactNode[] = projection.tabs.map((tab) => {
    const tabActive = tab.id === activeTabId;
    const context: WorkbenchTabRenderContext = {
      tab,
      pane: projection.pane,
      container,
      project,
      group,
      active: tabActive,
      hidden: !tabActive,
    };
    return (
      <div
        className="terra-pane-tab-surface"
        key={tab.id}
        aria-hidden={!tabActive}
        data-tab-id={tab.id}
        data-active={tabActive}
      >
        {renderTab(context)}
      </div>
    );
  });

  return (
    <section
      className="terra-pane-frame"
      data-pane-id={projection.pane.id}
      data-active={active}
      aria-label={t("workbench.pane", { name: projection.pane.id })}
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
