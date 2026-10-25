import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Group as PanelGroup, Panel, Separator } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import { detectShortcutPlatform } from "../../lib/platform/shortcuts";
import type { ShellSurface } from "../../stores/shellStore";
import { useT } from "../../i18n";
import { RightDock, type RightDockProps } from "./RightDock";
import { WindowChrome, type WindowChromeProps } from "./WindowChrome";
import "./shell.css";
import { FULL_PERCENT } from "../../lib/math/percent";

/** The content panel never shrinks below this share of the window, in percent. */
const MIN_CONTENT_PERCENT = 35;
const DEFAULT_NAVIGATOR_PERCENT = 18;
const DEFAULT_DOCK_PERCENT = 22;

export interface ApplicationShellProps {
  chrome?: WindowChromeProps;
  surface?: ShellSurface;
  /** Full sidebar: surface switch, projects and agents, footer. */
  sidebar: ReactNode;
  /** 56px rail shown instead of the sidebar while it is collapsed. */
  collapsedSidebar?: ReactNode;
  isSidebarCollapsed?: boolean;
  children: ReactNode;
  rightDock?: RightDockProps | false;
  /** Floating layers that sit above the content (voice capsule). */
  overlay?: ReactNode;
  className?: string;
  defaultLayout?: Layout;
  onLayoutChanged?: (layout: Layout) => void;
}

function useCompactShell(): boolean {
  const [isCompact, setCompact] = useState(false);

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

  return isCompact;
}

/** Keep only the panels that are mounted; react-resizable-panels rejects unknown ids. */
function layoutFor(stored: Layout | undefined, hasSidebar: boolean, hasDock: boolean): Layout {
  const sidebar = hasSidebar ? stored?.navigator ?? DEFAULT_NAVIGATOR_PERCENT : 0;
  const dock = hasDock ? stored?.dock ?? DEFAULT_DOCK_PERCENT : 0;
  const layout: Layout = { content: Math.max(MIN_CONTENT_PERCENT, FULL_PERCENT - sidebar - dock) };
  if (hasSidebar) layout.navigator = sidebar;
  if (hasDock) layout.dock = dock;
  return layout;
}

export function ApplicationShell({
  chrome,
  surface = "workbench",
  sidebar,
  collapsedSidebar,
  isSidebarCollapsed = false,
  children,
  rightDock = false,
  overlay,
  className = "",
  defaultLayout,
  onLayoutChanged,
}: ApplicationShellProps) {
  const dockProps = rightDock === false ? undefined : rightDock;
  const isDockEnabled = dockProps !== undefined && dockProps.isOpen !== false;
  const translate = useT();
  const isCompact = useCompactShell();
  const [isCompactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const shouldShowSidebarPanel = !isSidebarCollapsed;
  const layout = useMemo(
    () => layoutFor(defaultLayout, shouldShowSidebarPanel, isDockEnabled),
    [defaultLayout, isDockEnabled, shouldShowSidebarPanel],
  );
  const shellClassName = ["terra-shell", className].filter(Boolean).join(" ");

  useEffect(() => {
    if (!isCompact) setCompactSidebarOpen(false);
  }, [isCompact]);

  // In compact mode ⌘B (which flips the persisted collapse flag) opens and
  // closes the drawer, and leaving a surface closes it.
  const lastCollapsed = useRef(isSidebarCollapsed);
  useEffect(() => {
    if (lastCollapsed.current === isSidebarCollapsed) return;
    lastCollapsed.current = isSidebarCollapsed;
    if (isCompact) setCompactSidebarOpen((isCurrentlyOpen) => !isCurrentlyOpen);
  }, [isCompact, isSidebarCollapsed]);
  useEffect(() => {
    setCompactSidebarOpen(false);
  }, [surface]);

  const compactChrome: WindowChromeProps | undefined = isCompact
    ? {
      ...chrome,
      isSidebarCollapsed: !isCompactSidebarOpen,
      onToggleSidebar: () => setCompactSidebarOpen((isCurrentlyOpen) => !isCurrentlyOpen),
    }
    : chrome;

  return (
    <div
      className={shellClassName}
      data-platform={detectShortcutPlatform()}
      data-shell-surface={surface}
      data-sidebar={isSidebarCollapsed ? "collapsed" : "expanded"}
    >
      <WindowChrome {...compactChrome} />
      <div className="terra-shell-body">
        {isCompact ? (
          <div className="terra-shell-compact-content">
            {isCompactSidebarOpen ? (
              <>
                <button className="terra-shell-compact-backdrop" type="button" aria-label={translate("shell.sidebar.collapse")} onClick={() => setCompactSidebarOpen(false)} />
                <div
                  className="terra-shell-compact-drawer terra-shell-compact-navigator"
                  onClick={(event) => {
                    // Picking a project or agent closes the drawer; the row's own buttons don't.
                    const target = event.target as HTMLElement;
                    if (target.closest('[role="treeitem"]') && !target.closest("button")) setCompactSidebarOpen(false);
                  }}
                >
                  {sidebar}
                </div>
              </>
            ) : null}
            <main className="terra-shell-compact-main">{children}</main>
            {isDockEnabled && dockProps ? (
              <div className="terra-shell-compact-drawer terra-shell-compact-dock">
                <RightDock {...dockProps} isOpen />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {isSidebarCollapsed ? <div className="terra-shell-rail-slot">{collapsedSidebar}</div> : null}
            <PanelGroup
              className="terra-shell-panel-group"
              id="terra-application-shell"
              orientation="horizontal"
              defaultLayout={layout}
              onLayoutChanged={onLayoutChanged}
              resizeTargetMinimumSize={{ coarse: 20, fine: 10 }}
            >
              {shouldShowSidebarPanel ? (
                <>
                  <Panel id="navigator" className="terra-shell-panel" data-slot="navigator" minSize="220px" maxSize="420px">
                    <div className="terra-shell-panel-slot" data-slot="navigator">{sidebar}</div>
                  </Panel>
                  <Separator id="navigator-separator" className="terra-shell-separator" aria-label={translate("shell.sidebar.resize")} />
                </>
              ) : null}
              <Panel id="content" className="terra-shell-panel" data-slot="content" minSize={`${MIN_CONTENT_PERCENT}%`}>
                <div className="terra-shell-panel-slot" data-slot="content">{children}</div>
              </Panel>
              {isDockEnabled ? (
                <>
                  <Separator id="dock-separator" className="terra-shell-separator" aria-label={translate("shell.inspector.resize")} />
                  <Panel id="dock" className="terra-shell-panel" data-slot="dock" minSize="260px" maxSize="480px">
                    <div className="terra-shell-panel-slot" data-slot="dock">
                      {dockProps ? <RightDock {...dockProps} isOpen /> : null}
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
