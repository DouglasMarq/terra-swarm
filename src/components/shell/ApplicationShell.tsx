import { useEffect, useState, type ReactNode } from "react";
import { Group as PanelGroup, Panel, Separator } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import { PanelRightOpen } from "lucide-react";
import { detectShortcutPlatform } from "../../lib/platform/shortcuts";
import { ActivityRail, type ActivityRailProps } from "./ActivityRail";
import {
  RightDock,
  type RightDockProps,
} from "./RightDock";
import {
  WindowChrome,
  type WindowChromeProps,
} from "./WindowChrome";
import "./shell.css";

export interface ApplicationShellProps {
  chrome?: WindowChromeProps;
  activity?: ActivityRailProps;
  navigator: ReactNode;
  children: ReactNode;
  rightDock?: RightDockProps | false;
  telemetry?: ReactNode;
  className?: string;
  defaultLayout?: Layout;
  onLayoutChanged?: (layout: Layout) => void;
}

const NAVIGATOR_ONLY_LAYOUT: Layout = {
  navigator: 25,
  content: 75,
};

const WITH_DOCK_LAYOUT: Layout = {
  navigator: 23,
  content: 57,
  dock: 20,
};

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

export function ApplicationShell({
  chrome,
  activity,
  navigator,
  children,
  rightDock = false,
  telemetry,
  className = "",
  defaultLayout,
  onLayoutChanged,
}: ApplicationShellProps) {
  const dockProps = rightDock === false ? undefined : rightDock;
  const dockEnabled = dockProps !== undefined && dockProps.open !== false;
  const compact = useCompactShell();
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [compactDockOpen, setCompactDockOpen] = useState(false);
  const layout = defaultLayout ?? (dockEnabled ? WITH_DOCK_LAYOUT : NAVIGATOR_ONLY_LAYOUT);
  const shellClassName = ["terra-shell", className].filter(Boolean).join(" ");

  useEffect(() => {
    if (!compact) {
      setNavigatorOpen(false);
      setCompactDockOpen(false);
    }
  }, [compact]);

  const compactDockProps = dockProps
    ? {
      ...dockProps,
      open: true,
      onClose: () => {
        setCompactDockOpen(false);
        dockProps.onClose?.();
      },
    }
    : undefined;

  return (
    <div
      className={shellClassName}
      data-platform={detectShortcutPlatform()}
      data-shell-surface={chrome?.activeSurface ?? "home"}
    >
      <WindowChrome {...chrome} />
      <div className="terra-shell-body">
        <ActivityRail {...activity} />
        {compact ? (
          <div className="terra-shell-compact-layout">
            <div className="terra-shell-compact-actions" role="toolbar" aria-label="Painéis compactos do shell">
              <button
                type="button"
                aria-controls="terra-compact-navigator"
                aria-expanded={navigatorOpen}
                onClick={() => setNavigatorOpen((open) => !open)}
              >
                Navegador
              </button>
              {dockProps ? (
                <button
                  type="button"
                  aria-controls="terra-compact-dock"
                  aria-expanded={compactDockOpen}
                  onClick={() => {
                    if (compactDockOpen) {
                      setCompactDockOpen(false);
                      dockProps.onClose?.();
                    } else {
                      setCompactDockOpen(true);
                      dockProps.onOpen?.();
                    }
                  }}
                >
                  Inspetor
                </button>
              ) : null}
            </div>
            <div className="terra-shell-compact-content">
              {navigatorOpen ? (
                <>
                  <button className="terra-shell-compact-backdrop" type="button" aria-label="Fechar gaveta do navegador" onClick={() => setNavigatorOpen(false)} />
                  <aside className="terra-shell-compact-drawer terra-shell-compact-navigator" id="terra-compact-navigator" aria-label="Navegador">
                    <div className="terra-shell-compact-drawer-header">
                      <strong>Navegador</strong>
                      <button type="button" aria-label="Fechar navegador" onClick={() => setNavigatorOpen(false)}>×</button>
                    </div>
                    <div className="terra-shell-compact-drawer-content">{navigator ?? <div className="terra-shell-slot-empty">Navegador indisponível</div>}</div>
                  </aside>
                </>
              ) : null}
              <main className="terra-shell-compact-main">{children}</main>
              {compactDockOpen && compactDockProps ? (
                <aside className="terra-shell-compact-drawer terra-shell-compact-dock" id="terra-compact-dock" aria-label="Painel contextual">
                  <RightDock {...compactDockProps} />
                </aside>
              ) : null}
            </div>
          </div>
        ) : (
          <PanelGroup
            className="terra-shell-panel-group"
            id="terra-application-shell"
            orientation="horizontal"
            defaultLayout={layout}
            onLayoutChanged={onLayoutChanged}
            resizeTargetMinimumSize={{ coarse: 20, fine: 10 }}
          >
            <Panel
              id="navigator"
              className="terra-shell-panel"
              data-slot="navigator"
              defaultSize={dockEnabled ? "23%" : "25%"}
              minSize="190px"
              maxSize="420px"
            >
              <div className="terra-shell-panel-slot" data-slot="navigator">
                {navigator ?? <div className="terra-shell-slot-empty">Navegador indisponível</div>}
              </div>
            </Panel>
            <Separator
              id="navigator-separator"
              className="terra-shell-separator"
              aria-label="Redimensionar navegador"
            />
            <Panel
              id="content"
              className="terra-shell-panel"
              data-slot="content"
              minSize="35%"
            >
              <div className="terra-shell-panel-slot" data-slot="content">{children}</div>
            </Panel>
            {dockEnabled && (
              <>
                <Separator
                  id="dock-separator"
                  className="terra-shell-separator"
                  aria-label="Redimensionar painel contextual"
                />
                <Panel
                  id="dock"
                  className="terra-shell-panel"
                  data-slot="dock"
                  defaultSize="20%"
                  minSize="250px"
                  maxSize="480px"
                >
                  <div className="terra-shell-panel-slot" data-slot="dock">
                    {dockProps && <RightDock {...dockProps} open />}
                  </div>
                </Panel>
              </>
            )}
          </PanelGroup>
        )}
        {!compact && dockProps && !dockEnabled && dockProps.onOpen ? (
          <button
            className="terra-shell-dock-reopen"
            data-shell-slot="dock-reopen"
            type="button"
            aria-label="Abrir painel contextual"
            title="Abrir painel contextual"
            onClick={dockProps.onOpen}
          >
            <PanelRightOpen size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="terra-shell-telemetry" aria-label="Telemetria de execução">
        {telemetry}
      </div>
    </div>
  );
}

export { ActivityRail } from "./ActivityRail";
export { RightDock } from "./RightDock";
export { WindowChrome } from "./WindowChrome";
