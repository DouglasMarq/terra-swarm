import { useT, type MessageKey } from "../../i18n";
import { errorMessage } from "../../lib/errors/errorMessage";
import { AlertCircle, FileText, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace, WorkspaceGitStatus } from "../../domain/workspace.model";
import type { NavigatorGitLoader } from "./types";
import styles from "./Navigator.module.css";

export interface NavigatorGitViewProps {
  workspaces: readonly Workspace[];
  activeWorkspaceId?: string | null;
  loadGitStatus: NavigatorGitLoader;
  onSelectWorkspace?: (workspaceId: string) => void;
}

const sections: ReadonlyArray<{ key: keyof Pick<WorkspaceGitStatus, "conflicted" | "staged" | "modified" | "untracked">; label: MessageKey }> = [
  { key: "conflicted", label: "nav.git.conflicted" },
  { key: "staged", label: "nav.git.staged" },
  { key: "modified", label: "nav.git.modified" },
  { key: "untracked", label: "nav.git.untracked" },
];

export function NavigatorGitView({
  workspaces,
  activeWorkspaceId = null,
  loadGitStatus,
  onSelectWorkspace,
}: NavigatorGitViewProps) {
  const translate = useT();
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
      setError(errorMessage(reason, ""));
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
          <span>{translate("nav.project")}</span>
          <select aria-label={translate("nav.git.project")} className={styles.integrationSelect} onChange={(event) => onSelectWorkspace?.(event.target.value)} value={workspace?.id ?? ""}>
            <option value="">{translate("nav.pickProject")}</option>
            {workspaces.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <button aria-label={translate("nav.git.refresh")} className={styles.integrationRefresh} disabled={!workspace || loading} onClick={() => void refresh()} type="button"><RefreshCw size={13} /></button>
      </div>
      {!workspace ? <div className={styles.integrationEmpty}>{translate("nav.git.pick")}</div> : null}
      {workspace && loading && !status ? <div className={styles.integrationLoading}><LoaderCircle className={styles.spin} size={14} /> {translate("nav.git.loading")}</div> : null}
      {workspace && error !== null ? <div className={styles.integrationError}><AlertCircle aria-hidden="true" size={14} /><span>{error || translate("nav.git.error")}</span><button aria-label={translate("nav.retry")} onClick={() => void refresh()} type="button"><RefreshCw size={12} /></button></div> : null}
      {workspace && status ? (
        <div className={styles.integrationList}>
          <div className={styles.gitBranchRow}><GitBranch aria-hidden="true" size={14} /><strong>{status.branch ?? translate("nav.git.detached")}</strong>{changedCount > 0 ? <span className={styles.integrationMeta}>{translate("nav.git.changes", { count: changedCount })}</span> : null}</div>
          {status.ahead || status.behind ? <div className={styles.integrationNotice}>{status.ahead ? translate("nav.git.ahead", { count: status.ahead }) : ""}{status.ahead && status.behind ? " · " : ""}{status.behind ? translate("nav.git.behind", { count: status.behind }) : ""}</div> : null}
          {sections.map((section) => {
            const paths = status[section.key];
            if (paths.length === 0) return null;
            return (
              <section className={styles.gitSection} key={section.key}>
                <div className={styles.sectionHeader}><span>{translate(section.label)}</span><span className={styles.sectionCount}>{paths.length}</span></div>
                {paths.map((path) => <div className={styles.integrationPath} key={path}><FileText aria-hidden="true" size={12} /><span>{path}</span></div>)}
              </section>
            );
          })}
          {changedCount === 0 ? <div className={styles.integrationEmpty}>{translate("nav.git.clean")}</div> : null}
        </div>
      ) : null}
    </section>
  );
}
