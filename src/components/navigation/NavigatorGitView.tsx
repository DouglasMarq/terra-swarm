import { t } from "../../i18n";
import { AlertCircle, FileText, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace, WorkspaceGitStatus } from "../../types";
import type { NavigatorGitLoader } from "./types";
import styles from "./Navigator.module.css";

export interface NavigatorGitViewProps {
  workspaces: readonly Workspace[];
  activeWorkspaceId?: string | null;
  loadGitStatus: NavigatorGitLoader;
  onSelectWorkspace?: (workspaceId: string) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return t("nav.git.error");
}

const sections: ReadonlyArray<{ key: keyof Pick<WorkspaceGitStatus, "conflicted" | "staged" | "modified" | "untracked">; label: string }> = [
  { key: "conflicted", get label() { return t("nav.git.conflicted"); } },
  { key: "staged", label: "Staged" },
  { key: "modified", get label() { return t("nav.git.modified"); } },
  { key: "untracked", get label() { return t("nav.git.untracked"); } },
];

export function NavigatorGitView({
  workspaces,
  activeWorkspaceId = null,
  loadGitStatus,
  onSelectWorkspace,
}: NavigatorGitViewProps) {
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;
  const workspaceId = workspace?.id ?? null;
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    if (!workspaceId) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const nextStatus = await loadGitStatus(workspaceId);
      if (currentRequest !== requestId.current) return;
      setStatus(nextStatus);
    } catch (reason) {
      if (currentRequest !== requestId.current) return;
      setStatus(null);
      setError(errorMessage(reason));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [loadGitStatus, workspaceId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestId.current += 1;
    };
  }, [refresh]);

  const changedCount = status
    ? status.staged.length + status.modified.length + status.untracked.length + status.conflicted.length
    : 0;

  return (
    <section aria-label="Git" className={styles.integrationView}>
      <div className={styles.integrationToolbar}>
        <label className={styles.integrationSelectLabel}>
          <span>{t("nav.project")}</span>
          <select aria-label={t("nav.git.project")} className={styles.integrationSelect} onChange={(event) => onSelectWorkspace?.(event.target.value)} value={workspace?.id ?? ""}>
            <option value="">{t("nav.pickProject")}</option>
            {workspaces.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <button aria-label={t("nav.git.refresh")} className={styles.integrationRefresh} disabled={!workspace || loading} onClick={() => void refresh()} type="button"><RefreshCw size={13} /></button>
      </div>
      {!workspace ? <div className={styles.integrationEmpty}>{t("nav.git.pick")}</div> : null}
      {workspace && loading && !status ? <div className={styles.integrationLoading}><LoaderCircle className={styles.spin} size={14} /> {t("nav.git.loading")}</div> : null}
      {workspace && error ? <div className={styles.integrationError}><AlertCircle aria-hidden="true" size={14} /><span>{error}</span><button aria-label={t("nav.retry")} onClick={() => void refresh()} type="button"><RefreshCw size={12} /></button></div> : null}
      {workspace && status ? (
        <div className={styles.integrationList}>
          <div className={styles.gitBranchRow}><GitBranch aria-hidden="true" size={14} /><strong>{status.branch ?? t("nav.git.detached")}</strong>{changedCount > 0 ? <span className={styles.integrationMeta}>{t("nav.git.changes", { count: changedCount })}</span> : null}</div>
          {status.ahead || status.behind ? <div className={styles.integrationNotice}>{status.ahead ? t("nav.git.ahead", { count: status.ahead }) : ""}{status.ahead && status.behind ? " · " : ""}{status.behind ? t("nav.git.behind", { count: status.behind }) : ""}</div> : null}
          {sections.map((section) => {
            const paths = status[section.key];
            if (paths.length === 0) return null;
            return (
              <section className={styles.gitSection} key={section.key}>
                <div className={styles.sectionHeader}><span>{section.label}</span><span className={styles.sectionCount}>{paths.length}</span></div>
                {paths.map((path) => <div className={styles.integrationPath} key={path}><FileText aria-hidden="true" size={12} /><span>{path}</span></div>)}
              </section>
            );
          })}
          {changedCount === 0 ? <div className={styles.integrationEmpty}>{t("nav.git.clean")}</div> : null}
        </div>
      ) : null}
    </section>
  );
}
