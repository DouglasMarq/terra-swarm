import { t } from "../../i18n";
import { AlertCircle, ChevronDown, ChevronRight, FileText, Folder, Link2, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Workspace, WorkspaceFileEntry, WorkspaceFileListing } from "../../types";
import type { NavigatorFilesLoader } from "./types";
import styles from "./Navigator.module.css";

const FILE_LIST_LIMIT = 200;

interface DirectoryState {
  listing: WorkspaceFileListing | null;
  loading: boolean;
  error: string | null;
}

export interface NavigatorFilesViewProps {
  workspaces: readonly Workspace[];
  activeWorkspaceId?: string | null;
  loadFiles: NavigatorFilesLoader;
  onSelectWorkspace?: (workspaceId: string) => void;
  /** Open a file in the editor; files stay static rows without it. */
  onOpenFile?: (workspaceId: string, path: string) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return t("nav.filesView.error");
}

function FileIcon({ entry }: { entry: WorkspaceFileEntry }) {
  if (entry.kind === "directory") return <Folder aria-hidden="true" size={14} />;
  if (entry.kind === "symlink") return <Link2 aria-hidden="true" size={14} />;
  return <FileText aria-hidden="true" size={14} />;
}

function FileRow({
  entry,
  expanded,
  loading,
  depth,
  onToggle,
  onOpen,
}: {
  entry: WorkspaceFileEntry;
  expanded: boolean;
  loading: boolean;
  depth: number;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const directory = entry.kind === "directory";
  const rowContent = (
    <>
      <span className={styles.integrationDisclosure}>
        {directory ? (expanded ? <ChevronDown aria-hidden="true" size={12} /> : <ChevronRight aria-hidden="true" size={12} />) : null}
      </span>
      <span className={styles.integrationIcon}><FileIcon entry={entry} /></span>
      <span className={styles.integrationName}>{entry.name}</span>
      {loading ? <LoaderCircle aria-label="Carregando" className={styles.spin} size={12} /> : null}
      {entry.kind === "file" && entry.size !== null ? <span className={styles.integrationMeta}>{entry.size} B</span> : null}
    </>
  );
  if (!directory && entry.kind === "file" && onOpen) {
    return (
      <button
        aria-label={t("editor.open", { name: entry.name })}
        className={styles.integrationRow}
        onClick={onOpen}
        style={{ paddingInlineStart: `${8 + depth * 16}px` }}
        type="button"
      >
        {rowContent}
      </button>
    );
  }
  if (!directory) {
    return (
      <div
        aria-label={`Arquivo ${entry.name}`}
        className={styles.integrationRow}
        data-file-static="true"
        role="listitem"
        style={{ paddingInlineStart: `${8 + depth * 16}px` }}
      >
        {rowContent}
      </div>
    );
  }
  return (
    <button
      aria-expanded={expanded}
      className={styles.integrationRow}
      onClick={onToggle}
      style={{ paddingInlineStart: `${8 + depth * 16}px` }}
      type="button"
    >
      {rowContent}
    </button>
  );
}

export function NavigatorFilesView({
  workspaces,
  activeWorkspaceId = null,
  loadFiles,
  onSelectWorkspace,
  onOpenFile,
}: NavigatorFilesViewProps) {
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const directoriesRef = useRef<Record<string, DirectoryState>>({});
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set([""]));
  const generation = useRef(0);
  const workspaceId = workspace?.id ?? null;

  const loadDirectory = useCallback(async (relativePath: string, force = false) => {
    if (!workspaceId) return;
    const existing = directoriesRef.current[relativePath];
    if (!force && (existing?.loading || existing?.listing)) return;
    const currentGeneration = generation.current;
    setDirectories((current) => {
      const next = {
        ...current,
        [relativePath]: { listing: current[relativePath]?.listing ?? null, loading: true, error: null },
      };
      directoriesRef.current = next;
      return next;
    });
    try {
      const listing = await loadFiles(workspaceId, relativePath, FILE_LIST_LIMIT);
      if (currentGeneration !== generation.current) return;
      setDirectories((current) => {
        const next = { ...current, [relativePath]: { listing, loading: false, error: null } };
        directoriesRef.current = next;
        return next;
      });
    } catch (error) {
      if (currentGeneration !== generation.current) return;
      setDirectories((current) => {
        const next = {
          ...current,
          [relativePath]: { listing: current[relativePath]?.listing ?? null, loading: false, error: errorMessage(error) },
        };
        directoriesRef.current = next;
        return next;
      });
    }
  }, [loadFiles, workspaceId]);

  useEffect(() => {
    generation.current += 1;
    directoriesRef.current = {};
    setDirectories({});
    setExpandedPaths(new Set([""]));
    if (workspaceId) void loadDirectory("");
  }, [loadDirectory, workspaceId]);

  const toggleDirectory = (entry: WorkspaceFileEntry) => {
    if (entry.kind !== "directory") return;
    const isExpanded = expandedPaths.has(entry.path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (isExpanded) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!isExpanded) void loadDirectory(entry.path);
  };

  const renderDirectory = (relativePath: string, depth: number): ReactNode => {
    const state = directories[relativePath];
    if (!state) return null;
    if (state.error && !state.listing) {
      return (
        <div className={styles.integrationError} style={{ paddingInlineStart: `${12 + depth * 16}px` }}>
          <AlertCircle aria-hidden="true" size={13} />
          <span>{state.error}</span>
          <button aria-label={t("nav.retry")} onClick={() => void loadDirectory(relativePath, true)} type="button"><RefreshCw size={12} /></button>
        </div>
      );
    }
    if (state.loading && !state.listing) {
      return <div className={styles.integrationLoading}><LoaderCircle className={styles.spin} size={14} /> {t("nav.filesView.loading")}</div>;
    }
    if (!state.listing || state.listing.entries.length === 0) {
      return <div className={styles.integrationEmpty}>{t("nav.filesView.empty")}</div>;
    }
    return (
      <>
        {state.listing.entries.map((entry) => {
          const expanded = expandedPaths.has(entry.path);
          return (
            <div key={entry.path}>
              <FileRow depth={depth} entry={entry} expanded={expanded} loading={Boolean(directories[entry.path]?.loading)} onToggle={() => toggleDirectory(entry)} onOpen={onOpenFile && workspaceId ? () => onOpenFile(workspaceId, entry.path) : undefined} />
              {entry.kind === "directory" && expanded ? renderDirectory(entry.path, depth + 1) : null}
            </div>
          );
        })}
        {state.listing.truncated ? <div className={styles.integrationNotice}>{t("nav.filesView.truncated", { count: state.listing.limit })}</div> : null}
        {state.error ? <div className={styles.integrationNotice}>{state.error}</div> : null}
      </>
    );
  };

  return (
    <section aria-label={t("nav.files")} className={styles.integrationView}>
      <div className={styles.integrationToolbar}>
        <label className={styles.integrationSelectLabel}>
          <span>{t("nav.project")}</span>
          <select aria-label={t("nav.filesView.project")} className={styles.integrationSelect} onChange={(event) => onSelectWorkspace?.(event.target.value)} value={workspace?.id ?? ""}>
            <option value="">{t("nav.pickProject")}</option>
            {workspaces.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <button aria-label={t("nav.filesView.refresh")} className={styles.integrationRefresh} disabled={!workspace} onClick={() => void loadDirectory("", true)} type="button"><RefreshCw size={13} /></button>
      </div>
      {!workspace ? <div className={styles.integrationEmpty}>{t("nav.filesView.pick")}</div> : <div className={styles.integrationList}>{renderDirectory("", 0)}</div>}
    </section>
  );
}
