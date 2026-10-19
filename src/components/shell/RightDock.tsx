import type { ReactNode } from "react";
import { PanelRightClose } from "lucide-react";

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
  title = "Inspetor",
  content,
}: RightDockProps) {
  if (!open) return null;
  return (
    <aside className="terra-right-dock terra-anim-slide-in" aria-label="Inspetor do agente">
      <div className="terra-right-dock-header">
        <span className="terra-right-dock-title">{title}</span>
        <button
          className="terra-right-dock-close"
          type="button"
          onClick={onClose}
          aria-label="Fechar inspetor"
          title="Fechar inspetor"
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="terra-right-dock-content">{content}</div>
    </aside>
  );
}
