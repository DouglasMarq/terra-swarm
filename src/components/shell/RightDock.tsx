import type { ReactNode } from "react";
import { PanelRightClose } from "lucide-react";
import { useT } from "../../i18n";

export interface RightDockProps {
  open?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  title?: string;
  content?: ReactNode;
}

/** The agent inspector: opened on demand (⌘I), one panel, no tabs. */
export function RightDock({
  open = true,
  onClose,
  title,
  content,
}: RightDockProps) {
  const t = useT();
  if (!open) return null;
  return (
    <aside className="terra-right-dock terra-anim-slide-in" aria-label={t("shell.inspector.label")}>
      <div className="terra-right-dock-header">
        <span className="terra-right-dock-title">{title ?? t("shell.inspector.title")}</span>
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
      <div className="terra-right-dock-content">{content}</div>
    </aside>
  );
}
