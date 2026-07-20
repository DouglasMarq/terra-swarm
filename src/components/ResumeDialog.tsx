import { motion } from "motion/react";
import type { ResumeItem } from "../types";
import { backdropAnim, modalAnim } from "../motion";

interface Props {
  items: ResumeItem[];
  savedAt: number | null;
  onResume: (item: ResumeItem) => void;
  onDismiss: (item: ResumeItem) => void;
  onResumeAll: () => void;
  onDismissAll: () => void;
}

function HistoryIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <polyline points="12 7 12 12 15 15" />
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

function CopyIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function formatRelativeTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function ResumeDialog(props: Props) {
  const { items, savedAt } = props;
  return (
    <motion.div className="modal-backdrop blur-strong" {...backdropAnim}>
      <motion.div
        className="modal resume-modal"
        {...modalAnim}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="resume-header">
          <div className="resume-title-row">
            <HistoryIcon />
            <h2>Resume your agents</h2>
            <span className="resume-count">{items.length}</span>
          </div>
          <button
            className="resume-icon-btn"
            title="Dismiss all"
            onClick={props.onDismissAll}
          >
            ×
          </button>
        </div>
        <p className="resume-sub">
          Running when Terra Swarm last closed. Pick up where you left off.
        </p>
        <div className="resume-list">
          {items.map((item) => (
            <div className="resume-item" key={item.terminalId}>
              <div className="resume-item-top">
                <span className={`pane-badge agent-${item.agentId}`}>
                  {item.agentId}
                </span>
                <span className="resume-time">
                  {savedAt != null ? formatRelativeTime(savedAt) : ""}
                </span>
                <button
                  className="resume-icon-btn"
                  title="Dismiss"
                  onClick={() => props.onDismiss(item)}
                >
                  <TrashIcon />
                </button>
              </div>
              <div className="resume-ws" title={item.cwd}>
                {item.wsName}
              </div>
              <div className="resume-cmd-row">
                <code className="resume-cmd">{item.resumeCommand}</code>
                <button
                  className="resume-icon-btn"
                  title="Copy command"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(item.resumeCommand)
                      .catch(() => {})
                  }
                >
                  <CopyIcon />
                </button>
              </div>
              <div className="resume-item-actions">
                <button className="primary" onClick={() => props.onResume(item)}>
                  <PlayIcon /> Resume
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="resume-footer">
          <span className="resume-sessions">
            {items.length} session{items.length === 1 ? "" : "s"}
          </span>
          <div className="modal-actions">
            <button onClick={props.onDismissAll}>Dismiss all</button>
            <button className="primary" onClick={props.onResumeAll}>
              <PlayIcon /> Resume all ({items.length})
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
