import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Group as PanelGroup, Panel, Separator } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import { detectShortcutPlatform } from "../../lib/platform/shortcuts";
import type { ShellSurface } from "../../stores/shellStore";
import { useT } from "../../i18n";
import { RightDock, type RightDockProps } from "./RightDock";
import { WindowChrome, type WindowChromeProps } from "./WindowChrome";
import "./shell.css";

export interface ApplicationShellProps {
  chrome?: WindowChromeProps;
  surface?: ShellSurface;
  /** Full sidebar: surface switch, projects and agents, footer. */
  sidebar: ReactNode;
  /** 56px rail shown instead of the sidebar while it is collapsed. */
  collapsedSidebar?: ReactNode;
  sidebarCollapsed?: boolean;
  children: ReactNode;
  rightDock?: RightDockProps | false;
  /** Floating layers that sit above the content (voice capsule). */
  overlay?: ReactNode;
  className?: string;
  defaultLayout?: Layout;
  onLayoutChanged?: (layout: Layout) => void;
}

function useCompactShell(): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setCompact(media.matches);
    update();
    if (typeof media.addEventListener === "function") media.addEventListener("change", update);
    else media.addListener(update);
    return () => {
      if (typeof media.removeEventListener === "function") media.removeEventListener("change", update);
      else media.removeListener(update);
    };
  }, []);

  return compact;
}

/** Keep only the panels that are mounted; react-resizable-panels rejects unknown ids. */
function layoutFor(stored: Layout | undefined, withSidebar: boolean, withDock: boolean): Layout {
  const sidebar = withSidebar ? stored?.navigator ?? 18 : 0;
  const dock = withDock ? stored?.dock ?? 22 : 0;
  const layout: Layout = { content: Math.max(35, 100 - sidebar - dock) };
  if (withSidebar) layout.navigator = sidebar;
  if (withDock) layout.dock = dock;
  return layout;
}

export function ApplicationShell({
  chrome,
  surface = "workbench",
  sidebar,
  collapsedSidebar,
  sidebarCollapsed = false,
  children,
  rightDock = false,
  overlay,
  className = "",
  defaultLayout,
  onLayoutChanged,
}: ApplicationShellProps) {
  const dockProps = rightDock === false ? undefined : rightDock;
  const dockEnabled = dockProps !== undefined && dockProps.open !== false;
  const t = useT();
  const compact = useCompactShell();
  const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const showSidebarPanel = !sidebarCollapsed;
  const layout = useMemo(
    () => layoutFor(defaultLayout, showSidebarPanel, dockEnabled),
    [defaultLayout, dockEnabled, showSidebarPanel],
  );
  const shellClassName = ["terra-shell", className].filter(Boolean).join(" ");

  useEffect(() => {
    if (!compact) setCompactSidebarOpen(false);
  }, [compact]);

  const compactChrome: WindowChromeProps | undefined = compact
    ? {
      ...chrome,
      sidebarCollapsed: !compactSidebarOpen,
      onToggleSidebar: () => setCompactSidebarOpen((open) => !open),
    }
    : chrome;

  return (
    <div
      className={shellClassName}
      data-platform={detectShortcutPlatform()}
      data-shell-surface={surface}
      data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
    >
      <WindowChrome {...compactChrome} />
      <div className="terra-shell-body">
        {compact ? (
          <div className="terra-shell-compact-content">
            {compactSidebarOpen ? (
              <>
                <button className="terra-shell-compact-backdrop" type="button" aria-label={t("shell.sidebar.collapse")} onClick={() => setCompactSidebarOpen(false)} />
                <div className="terra-shell-compact-drawer terra-shell-compact-navigator">{sidebar}</div>
              </>
            ) : null}
            <main className="terra-shell-compact-main">{children}</main>
            {dockEnabled && dockProps ? (
              <div className="terra-shell-compact-drawer terra-shell-compact-dock">
                <RightDock {...dockProps} open />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {sidebarCollapsed ? <div className="terra-shell-rail-slot">{collapsedSidebar}</div> : null}
            <PanelGroup
              key={`${showSidebarPanel ? "s" : ""}${dockEnabled ? "d" : ""}`}
              className="terra-shell-panel-group"
              id="terra-application-shell"
              orientation="horizontal"
              defaultLayout={layout}
              onLayoutChanged={onLayoutChanged}
              resizeTargetMinimumSize={{ coarse: 20, fine: 10 }}
            >
              {showSidebarPanel ? (
                <>
                  <Panel id="navigator" className="terra-shell-panel" data-slot="navigator" minSize="220px" maxSize="420px">
                    <div className="terra-shell-panel-slot" data-slot="navigator">{sidebar}</div>
                  </Panel>
                  <Separator id="navigator-separator" className="terra-shell-separator" aria-label={t("shell.sidebar.resize")} />
                </>
              ) : null}
              <Panel id="content" className="terra-shell-panel" data-slot="content" minSize="35%">
                <div className="terra-shell-panel-slot" data-slot="content">{children}</div>
              </Panel>
              {dockEnabled ? (
                <>
                  <Separator id="dock-separator" className="terra-shell-separator" aria-label={t("shell.inspector.resize")} />
                  <Panel id="dock" className="terra-shell-panel" data-slot="dock" minSize="260px" maxSize="480px">
                    <div className="terra-shell-panel-slot" data-slot="dock">
                      {dockProps ? <RightDock {...dockProps} open /> : null}
                    </div>
                  </Panel>
                </>
              ) : null}
            </PanelGroup>
          </>
        )}
        {overlay}
      </div>
    </div>
  );
}

export { RightDock } from "./RightDock";
export { WindowChrome } from "./WindowChrome";
