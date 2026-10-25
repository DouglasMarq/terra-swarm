import type { ReactNode } from "react";
import { PanelRightClose } from "lucide-react";
import { useT } from "../../i18n";
import type { DockTab } from "../../stores/shellStore";

export interface RightDockTab {
  id: DockTab;
  label: string;
}

export interface RightDockProps {
  isOpen?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  title?: string;
  content?: ReactNode;
  tabs?: readonly RightDockTab[];
  activeTab?: DockTab;
  onTabChange?: (id: DockTab) => void;
}

export function RightDock({
  isOpen = true,
  onClose,
  title,
  content,
  tabs,
  activeTab,
  onTabChange,
}: RightDockProps) {
  const translate = useT();
  if (!isOpen) return null;
  const isTabbed = tabs !== undefined && tabs.length > 1;
  return (
    <aside className="terra-right-dock terra-anim-slide-in" aria-label={translate("shell.inspector.label")}>
      <div className="terra-right-dock-header">
        {isTabbed ? (
          <div className="terra-right-dock-tabs" role="tablist" aria-label={translate("shell.dock.tabs")}>
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
          <span className="terra-right-dock-title">{title ?? translate("shell.inspector.title")}</span>
        )}
        <button
          className="terra-right-dock-close"
          type="button"
          onClick={onClose}
          aria-label={translate("shell.inspector.hide")}
          title={translate("shell.inspector.hide")}
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="terra-right-dock-content" role={isTabbed ? "tabpanel" : undefined}>{content}</div>
    </aside>
  );
}
