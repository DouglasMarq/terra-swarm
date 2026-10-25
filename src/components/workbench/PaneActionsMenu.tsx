import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export interface PaneMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Secondary line, e.g. the resume command that will be copied. */
  detail?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Items in a group render together; groups are separated by a rule. */
export type PaneMenuGroups = readonly (readonly PaneMenuItem[])[];

export interface PaneActionsMenuProps {
  label: string;
  groups: PaneMenuGroups;
}

/**
 * The pane's "…" menu. It is the single home for the agent's lifecycle
 * actions; the header itself only keeps Maximize visible.
 */
export function PaneActionsMenu({ label, groups }: PaneActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The list lives in a portal with fixed coordinates: panes clip their
  // overflow, so an in-pane dropdown was cut off in dense grids. Open below
  // the trigger, flip above when there is no room, and stay on screen.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const trigger = rootRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const margin = 8;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.min(Math.max(margin, trigger.right - width), window.innerWidth - width - margin);
      let top = trigger.bottom + 4;
      if (top + height > window.innerHeight - margin) top = Math.max(margin, trigger.top - 4 - height);
      setPosition({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>(".pane-menu-trigger")?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="pane-menu" ref={rootRef} onMouseDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="pane-btn pane-menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div
          className="pane-menu-list terra-anim-pop"
          role="menu"
          aria-label={label}
          ref={menuRef}
          style={position ?? { top: 0, left: 0, visibility: "hidden" }}
          onKeyDown={onMenuKeyDown}
          onMouseDown={(event) => event.stopPropagation()}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && !menuRef.current?.contains(next)) setOpen(false);
          }}
        >
          {groups.filter((group) => group.length > 0).map((group, groupIndex) => (
            <div className="pane-menu-group" role="group" key={group[0]?.id ?? groupIndex}>
              {group.map((item) => (
                <button
                  type="button"
                  role="menuitem"
                  key={item.id}
                  className="pane-menu-item"
                  data-danger={item.danger}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  <span className="pane-menu-icon" aria-hidden="true">{item.icon}</span>
                  <span className="pane-menu-copy">
                    <span>{item.label}</span>
                    {item.detail ? <span className="pane-menu-detail">{item.detail}</span> : null}
                  </span>
                  {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
