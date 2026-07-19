import { useEffect, useRef, useState } from "react";
import type { NotificationItem, Workspace } from "../types";

interface Props {
  workspaces: Workspace[];
  activeName: string | null;
  items: NotificationItem[];
  onMarkAllRead: () => void;
  onClearAll: () => void;
  onJump: (item: NotificationItem) => void;
}

const AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  kimi: "Kimi",
  gemini: "Gemini",
  aider: "Aider",
  shell: "Shell",
};

function agentName(command: string | undefined): string {
  if (!command) return "Terminal";
  const first = command.split(" ")[0];
  return AGENT_NAMES[first] ?? first.charAt(0).toUpperCase() + first.slice(1);
}

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function BellIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

export function TopBar({
  workspaces,
  activeName,
  items,
  onMarkAllRead,
  onClearAll,
  onJump,
}: Props) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const wrapRef = useRef<HTMLDivElement>(null);
  const unread = items.reduce((n, it) => n + (it.read ? 0 : 1), 0);

  useEffect(() => {
    if (!open) return;
    const iv = setInterval(() => setNow(Date.now()), 30000);
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearInterval(iv);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <header className="topbar" data-tauri-drag-region>
      <span className="topbar-title" data-tauri-drag-region>
        Terra Swarm
      </span>
      {activeName && (
        <span className="topbar-ws" data-tauri-drag-region>
          {activeName}
        </span>
      )}
      <span className="topbar-spacer" data-tauri-drag-region />
      <div className="topbar-bell-wrap" ref={wrapRef}>
        <button
          className={`topbar-bell ${open ? "open" : ""}`}
          title="Notifications"
          onClick={() => setOpen((o) => !o)}
        >
          <BellIcon />
          {unread > 0 && (
            <span className="topbar-bell-badge" key={unread}>
              {unread}
            </span>
          )}
        </button>
        {open && (
          <div className="notif-panel">
            <div className="notif-head">
              <span className="notif-title">Notifications</span>
              {unread > 0 && (
                <span className="notif-unread">
                  {unread} unread
                </span>
              )}
              <span className="notif-head-spacer" />
              <button
                className="notif-icon-btn"
                title="Mark all read"
                disabled={unread === 0}
                onClick={onMarkAllRead}
              >
                <CheckIcon />
              </button>
              <button
                className="notif-icon-btn"
                title="Clear all"
                disabled={items.length === 0}
                onClick={onClearAll}
              >
                <TrashIcon />
              </button>
              <button
                className="notif-icon-btn"
                title="Close"
                onClick={() => setOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
            <div className="notif-list">
              {items.length === 0 ? (
                <div className="notif-empty">No notifications</div>
              ) : (
                items.map((n) => {
                  const ws = workspaces.find((w) => w.id === n.workspaceId);
                  const cmd = ws?.terminals.find(
                    (t) => t.id === n.terminalId,
                  )?.command;
                  return (
                    <div
                      key={n.key}
                      className={`notif-item ${n.read ? "" : "unread"}`}
                    >
                      <span className="notif-check">
                        <CheckCircleIcon />
                      </span>
                      <div className="notif-body">
                        <div className="notif-item-top">
                          <span className="notif-agent">{agentName(cmd)}</span>
                          {ws && <span className="notif-ws">{ws.name}</span>}
                          <span className="notif-time">
                            {relTime(n.ts, now)}
                          </span>
                        </div>
                        <div className="notif-msg" title={n.message}>
                          {n.message}
                        </div>
                        <button
                          className="notif-jump"
                          onClick={() => {
                            onJump(n);
                            setOpen(false);
                          }}
                        >
                          Jump to pane
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
