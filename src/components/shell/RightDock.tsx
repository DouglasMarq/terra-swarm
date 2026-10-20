import type { ReactNode } from "react";
import { PanelRightClose } from "lucide-react";
import { useT } from "../../i18n";

export interface RightDockTab {
  id: string;
  label: string;
}

export interface RightDockProps {
  open?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  title?: string;
  content?: ReactNode;
  /** With two or more tabs the header becomes a tab strip. */
  tabs?: readonly RightDockTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
}

/** The right dock: the agent inspector (⌘I) and the shared task board. */
export function RightDock({
  open = true,
  onClose,
  title,
  content,
  tabs,
  activeTab,
  onTabChange,
}: RightDockProps) {
  const t = useT();
  if (!open) return null;
  const tabbed = tabs !== undefined && tabs.length > 1;
  return (
    <aside className="terra-right-dock terra-anim-slide-in" aria-label={t("shell.inspector.label")}>
      <div className="terra-right-dock-header">
        {tabbed ? (
          <div className="terra-right-dock-tabs" role="tablist" aria-label={t("shell.dock.tabs")}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className="terra-right-dock-tab"
                aria-selected={tab.id === activeTab}
                onClick={() => onTabChange?.(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="terra-right-dock-title">{title ?? t("shell.inspector.title")}</span>
        )}
        <button
          className="terra-right-dock-close"
          type="button"
          onClick={onClose}
          aria-label={t("shell.inspector.hide")}
          title={t("shell.inspector.hide")}
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="terra-right-dock-content" role={tabbed ? "tabpanel" : undefined}>{content}</div>
    </aside>
  );
}
