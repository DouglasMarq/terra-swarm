import { useEffect, useRef, type ReactNode } from "react";
import { Bell, Mic, PanelLeft, PanelRight, Search } from "lucide-react";
import { useT, type Translate } from "../../i18n";
import { COMMAND_PALETTE_SHORTCUT, formatShortcut } from "../../lib/platform/shortcuts";

export interface ChromeBreadcrumb {
  project?: string | null;
  agent?: string | null;
  branch?: string | null;
}

export interface WindowChromeProps {
  /** Where the user is; falls back to `title` when no project is active. */
  breadcrumb?: ChromeBreadcrumb;
  title?: string;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  sidebarShortcut?: string;
  onOpenLauncher?: () => void;
  launcherShortcut?: string;
  /** Agents that need the user; drives the amber notification button. */
  attentionCount?: number;
  notificationsOpen?: boolean;
  onNotificationsOpenChange?: (open: boolean) => void;
  notificationsPanel?: ReactNode;
  onToggleVoice?: () => void;
  voiceActive?: boolean;
  voiceLabel?: string;
  voiceShortcut?: string;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  inspectorShortcut?: string;
}

function withShortcut(translate: Translate, label: string, shortcut?: string): string {
  return shortcut ? translate("common.withShortcut", { label, shortcut }) : label;
}

/**
 * Top bar: where you are, one way to search or command (⌘K), what needs you,
 * and the voice and inspector toggles. Everything else lives in the sidebar.
 */
export function WindowChrome({
  breadcrumb,
  title,
  sidebarCollapsed = false,
  onToggleSidebar,
  sidebarShortcut,
  onOpenLauncher,
  launcherShortcut = formatShortcut(COMMAND_PALETTE_SHORTCUT),
  attentionCount = 0,
  notificationsOpen = false,
  onNotificationsOpenChange,
  notificationsPanel,
  onToggleVoice,
  voiceActive = false,
  voiceLabel,
  voiceShortcut,
  inspectorOpen = false,
  onToggleInspector,
  inspectorShortcut,
}: WindowChromeProps) {
  const translate = useT();
  const notificationsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!notificationsOpen) return;
    const close = (event: PointerEvent) => {
      if (notificationsRef.current?.contains(event.target as Node)) return;
      onNotificationsOpenChange?.(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onNotificationsOpenChange?.(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [notificationsOpen, onNotificationsOpenChange]);

  const sidebarLabel = withShortcut(translate, translate(sidebarCollapsed ? "shell.sidebar.expand" : "shell.sidebar.collapse"), sidebarShortcut);
  const inspectorLabel = withShortcut(translate, translate(inspectorOpen ? "shell.inspector.hide" : "shell.inspector.show"), inspectorShortcut);
  const voiceTitle = withShortcut(translate, voiceLabel ?? translate("shell.voice"), voiceShortcut);
  const notificationLabel = attentionCount > 0
    ? translate("shell.attention.button", { count: attentionCount })
    : translate("shell.attention.notifications");

  return (
    <header className="terra-window-chrome" data-tauri-drag-region="true">
      {onToggleSidebar ? (
        <button
          className="terra-window-icon-button"
          type="button"
          onClick={onToggleSidebar}
          aria-label={sidebarLabel}
          aria-expanded={!sidebarCollapsed}
          title={sidebarLabel}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </button>
      ) : null}

      <nav className="terra-window-breadcrumb" aria-label={translate("shell.location")} data-tauri-drag-region="true">
        {breadcrumb?.project ? (
          <>
            <span className="terra-window-breadcrumb-project" data-tauri-drag-region="true">{breadcrumb.project}</span>
            {breadcrumb.agent ? (
              <>
                <span aria-hidden="true" data-tauri-drag-region="true">›</span>
                <span className="terra-window-breadcrumb-agent" data-tauri-drag-region="true">{breadcrumb.agent}</span>
              </>
            ) : null}
            {breadcrumb.branch ? (
              <span className="terra-window-branch" data-tauri-drag-region="true">{breadcrumb.branch}</span>
            ) : null}
          </>
        ) : (
          <span className="terra-window-breadcrumb-project" data-tauri-drag-region="true">{title ?? translate("common.appName")}</span>
        )}
      </nav>

      <div className="terra-window-search-slot" data-tauri-drag-region="true">
        <button
          className="terra-window-search"
          type="button"
          onClick={onOpenLauncher}
          aria-label={translate("shell.search.open")}
          title={withShortcut(translate, translate("shell.search.title"), launcherShortcut)}
        >
          <Search size={14} aria-hidden="true" />
          <span className="terra-window-search-label">{translate("shell.search.placeholder")}</span>
          <kbd>{launcherShortcut}</kbd>
        </button>
      </div>

      <div className="terra-window-actions">
        <div className="terra-window-popover-anchor" ref={notificationsRef}>
          <button
            className="terra-window-notifications"
            type="button"
            data-attention={attentionCount > 0}
            aria-haspopup="dialog"
            aria-expanded={notificationsOpen}
            aria-label={notificationLabel}
            title={notificationLabel}
            onClick={() => onNotificationsOpenChange?.(!notificationsOpen)}
          >
            {attentionCount > 0 ? <span className="terra-window-attention-dot" aria-hidden="true" /> : <Bell size={14} aria-hidden="true" />}
            {attentionCount > 0 ? <span>{notificationLabel}</span> : null}
          </button>
          {notificationsOpen && notificationsPanel ? (
            <div className="terra-window-popover terra-anim-pop">{notificationsPanel}</div>
          ) : null}
        </div>
        <button
          className="terra-window-icon-button terra-window-voice"
          type="button"
          onClick={onToggleVoice}
          data-recording={voiceActive}
          aria-pressed={voiceActive}
          aria-label={voiceTitle}
          title={voiceTitle}
        >
          <Mic size={15} aria-hidden="true" />
        </button>
        {onToggleInspector ? (
          <button
            className="terra-window-icon-button"
            type="button"
            onClick={onToggleInspector}
            aria-pressed={inspectorOpen}
            aria-label={inspectorLabel}
            title={inspectorLabel}
          >
            <PanelRight size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
