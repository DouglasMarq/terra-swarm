import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Workspace } from "../types";

interface Props {
  workspaces: Workspace[];
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReorder: (dragId: string, targetId: string) => void;
  onQuickNew: (id: string) => void;
  onPickNew: (id: string) => void;
  onOpenSettings: () => void;
  renameTrigger: { id: string; n: number } | null;
  notifications: Record<string, number>;
  branches: Record<string, string>;
}

function BranchIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function TerminalPlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 15 9 9 4 3" />
      <line x1="10" y1="17" x2="13" y2="17" />
      <line x1="18" y1="14" x2="18" y2="20" />
      <line x1="15" y1="17" x2="21" y2="17" />
    </svg>
  );
}

function TerminalMoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 15 9 9 4 3" />
      <line x1="10" y1="17" x2="13" y2="17" />
      <polyline points="16 15 18.5 17.5 21 15" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

export function Sidebar({
  workspaces,
  activeId,
  collapsed,
  onToggleCollapse,
  onSelect,
  onAdd,
  onClose,
  onRename,
  onReorder,
  onQuickNew,
  onPickNew,
  onOpenSettings,
  renameTrigger,
  notifications,
  branches,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const suppressClick = useRef(false);

  const openMenu = (e: ReactMouseEvent, ws: Workspace) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 200;
    const menuHeight = 150;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setMenu({ id: ws.id, x, y });
    onSelect(ws.id);
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const menuWorkspace = menu ? workspaces.find((w) => w.id === menu.id) : null;

  // Mouse-based reordering: Tauri keeps `dragDropEnabled` on for file drops
  // into terminals, which breaks HTML5 drag-and-drop inside the webview, so
  // `draggable` never fires. Same pattern as TerminalGrid's pane reorder.
  const startReorder = (e: ReactMouseEvent, ws: Workspace) => {
    if (e.button !== 0 || editingId === ws.id) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const targetAt = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y);
      const item = el?.closest("[data-ws-id]");
      return item?.getAttribute("data-ws-id") ?? null;
    };

    const onMove = (ev: MouseEvent) => {
      if (
        !dragging &&
        Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6
      ) {
        dragging = true;
        setDragId(ws.id);
        document.body.classList.add("reordering");
      }
      if (dragging) {
        const t = targetAt(ev.clientX, ev.clientY);
        setDropTargetId(t && t !== ws.id ? t : null);
      }
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("reordering");
      if (dragging) {
        suppressClick.current = true;
        // The flag is cleared by the item onClick that follows a drop on an
        // item; when the drag ends off-item no click fires, so clear it on
        // the next tick instead of swallowing a later legitimate click.
        setTimeout(() => {
          suppressClick.current = false;
        }, 0);
        const t = targetAt(ev.clientX, ev.clientY);
        if (t && t !== ws.id) onReorder(ws.id, t);
      }
      setDragId(null);
      setDropTargetId(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startEdit = (ws: Workspace) => {
    setEditingId(ws.id);
    setDraft(ws.name);
  };

  useEffect(() => {
    if (!renameTrigger) return;
    const ws = workspaces.find((w) => w.id === renameTrigger.id);
    if (ws) startEdit(ws);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameTrigger]);

  const commit = () => {
    if (editingId) {
      const name = draft.trim();
      if (name) onRename(editingId, name);
    }
    setEditingId(null);
  };

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button
          className="sidebar-collapse-btn"
          title="Expand sidebar"
          onClick={onToggleCollapse}
        >
          »
        </button>
        <div className="sidebar-dots">
          {workspaces.map((ws) => {
            const notifTotal = ws.terminals.reduce(
              (acc, t) => acc + (notifications[t.id] ?? 0),
              0,
            );
            return (
              <button
                key={ws.id}
                className={`sidebar-dot ${ws.id === activeId ? "active" : ""}`}
                title={`${ws.name} (${ws.terminals.length})`}
                onClick={() => {
                  onSelect(ws.id);
                  onToggleCollapse();
                }}
              >
                {ws.name.charAt(0).toUpperCase()}
                {notifTotal > 0 && <span className="sidebar-dot-notif" />}
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        <span>Workspaces</span>
        <button
          className="sidebar-collapse-btn"
          title="Collapse sidebar"
          onClick={onToggleCollapse}
        >
          «
        </button>
      </div>
      <div className="sidebar-list">
        {workspaces.map((ws) => {
          const notifTotal = ws.terminals.reduce(
              (acc, t) => acc + (notifications[t.id] ?? 0),
              0,
            );
          const branch = branches[ws.id];
          return (
            <div
              key={ws.id}
              data-ws-id={ws.id}
              title={ws.cwd}
              className={`sidebar-item ${ws.id === activeId ? "active" : ""} ${dragId === ws.id ? "dragging" : ""} ${dropTargetId === ws.id && dragId !== ws.id ? "drop-target" : ""}`}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                onSelect(ws.id);
              }}
              onDoubleClick={() => startEdit(ws)}
              onContextMenu={(e) => openMenu(e, ws)}
            >
              <div
                className="sidebar-item-main"
                onMouseDown={(e) => startReorder(e, ws)}
              >
                {editingId === ws.id ? (
                  <input
                    className="sidebar-rename-input"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                ) : (
                  <span className="sidebar-item-name">{ws.name}</span>
                )}
                {branch && (
                  <span className="sidebar-item-branch">
                    <BranchIcon />
                    {branch}
                  </span>
                )}
              </div>
              {notifTotal > 0 && (
                <span
                  className="sidebar-item-dot"
                  key={notifTotal}
                  title={`${notifTotal} notification${notifTotal > 1 ? "s" : ""}`}
                />
              )}
              <button
                className="sidebar-item-action"
                title="New terminal (default agent)"
                onClick={(e) => {
                  e.stopPropagation();
                  onQuickNew(ws.id);
                }}
              >
                <TerminalPlusIcon />
              </button>
              <button
                className="sidebar-item-action"
                title="Choose agent…"
                onClick={(e) => {
                  e.stopPropagation();
                  onPickNew(ws.id);
                }}
              >
                <TerminalMoreIcon />
              </button>
              <button
                className="sidebar-item-action"
                title="Rename workspace"
                onClick={(e) => {
                  e.stopPropagation();
                  startEdit(ws);
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                className="sidebar-item-action sidebar-item-close"
                title="Close workspace"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(ws.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="sidebar-footer">
        <button className="sidebar-add" onClick={onAdd}>
          + New workspace
        </button>
        <button
          className="sidebar-gear"
          title="Settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon />
        </button>
      </div>
      {menu && menuWorkspace && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              setMenu(null);
              onQuickNew(menu.id);
            }}
          >
            New terminal
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              setMenu(null);
              onPickNew(menu.id);
            }}
          >
            Choose agent…
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              setMenu(null);
              startEdit(menuWorkspace);
            }}
          >
            Rename
          </button>
          <div className="context-menu-separator" />
          <button
            className="context-menu-item danger"
            onClick={() => {
              setMenu(null);
              onClose(menu.id);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </aside>
  );
}
