import { useT } from "../../i18n";
import { errorMessage } from "../../lib/errors/errorMessage";
import { DEFAULT_FILE_LIST_LIMIT } from "../../lib/tauri/workspace";
import { AlertCircle, ChevronDown, ChevronRight, FileText, Folder, Link2, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Workspace } from "../../domain/workspace.model";
import type { WorkspaceFileEntry, WorkspaceFileListing } from "../../domain/workspaceFiles.model";
import type { NavigatorFilesLoader } from "./types";
import { indentFor, messageIndentFor } from "./indent";
import styles from "./Navigator.module.css";


interface DirectoryState {
  listing: WorkspaceFileListing | null;
  isLoading: boolean;
  error: string | null;
}

export interface NavigatorFilesViewProps {
  workspaces: readonly Workspace[];
  activeWorkspaceId?: string | null;
  loadFiles: NavigatorFilesLoader;
  onSelectWorkspace?: (workspaceId: string) => void;
  onOpenFile?: (workspaceId: string, path: string) => void;
}

function FileIcon({ entry }: { entry: WorkspaceFileEntry }) {
  if (entry.kind === "directory") return <Folder aria-hidden="true" size={14} />;
  if (entry.kind === "symlink") return <Link2 aria-hidden="true" size={14} />;
  return <FileText aria-hidden="true" size={14} />;
}

function FileRow({
  entry,
  isExpanded,
  isLoading,
  depth,
  onToggle,
  onOpen,
}: {
  entry: WorkspaceFileEntry;
  isExpanded: boolean;
  isLoading: boolean;
  depth: number;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const translate = useT();
  const isDirectory = entry.kind === "directory";
  const rowContent = (
    <>
      <span className={styles.integrationDisclosure}>
        {isDirectory ? (isExpanded ? <ChevronDown aria-hidden="true" size={12} /> : <ChevronRight aria-hidden="true" size={12} />) : null}
      </span>
      <span className={styles.integrationIcon}><FileIcon entry={entry} /></span>
      <span className={styles.integrationName}>{entry.name}</span>
      {isLoading ? <LoaderCircle aria-label={translate("nav.filesView.loadingEntry")} className={styles.spin} size={12} /> : null}
      {entry.kind === "file" && entry.size !== null ? <span className={styles.integrationMeta}>{translate("nav.filesView.sizeBytes", { size: entry.size })}</span> : null}
    </>
  );
  if (!isDirectory && entry.kind === "file" && onOpen) {
    return (
      <button
        aria-label={translate("editor.open", { name: entry.name })}
        className={styles.integrationRow}
        onClick={onOpen}
        style={{ paddingInlineStart: indentFor(depth) }}
        type="button"
      >
        {rowContent}
      </button>
    );
  }
  if (!isDirectory) {
    return (
      <div
        aria-label={translate("nav.filesView.fileRow", { name: entry.name })}
        className={styles.integrationRow}
        data-file-static="true"
        role="listitem"
        style={{ paddingInlineStart: indentFor(depth) }}
      >
        {rowContent}
      </div>
    );
  }
  return (
    <button
      aria-expanded={isExpanded}
      className={styles.integrationRow}
      onClick={onToggle}
      style={{ paddingInlineStart: indentFor(depth) }}
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
  const translate = useT();
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const directoriesRef = useRef<Record<string, DirectoryState>>({});
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set([""]));
  const generation = useRef(0);
  const workspaceId = workspace?.id ?? null;

  const loadDirectory = useCallback(async (relativePath: string, shouldForce = false) => {
    if (!workspaceId) return;
    const existing = directoriesRef.current[relativePath];
    if (!shouldForce && (existing?.isLoading || existing?.listing)) return;
    const currentGeneration = generation.current;
    setDirectories((current) => {
      const next = {
        ...current,
        [relativePath]: { listing: current[relativePath]?.listing ?? null, isLoading: true, error: null },
      };
      directoriesRef.current = next;
      return next;
    });
    try {
      const listing = await loadFiles(workspaceId, relativePath, DEFAULT_FILE_LIST_LIMIT);
      if (currentGeneration !== generation.current) return;
      setDirectories((current) => {
        const next = { ...current, [relativePath]: { listing, isLoading: false, error: null } };
        directoriesRef.current = next;
        return next;
      });
    } catch (error) {
      if (currentGeneration !== generation.current) return;
      setDirectories((current) => {
        const next = {
          ...current,
          [relativePath]: { listing: current[relativePath]?.listing ?? null, isLoading: false, error: errorMessage(error, "") },
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
    if (state.error !== null && !state.listing) {
      return (
        <div className={styles.integrationError} style={{ paddingInlineStart: messageIndentFor(depth) }}>
          <AlertCircle aria-hidden="true" size={13} />
          <span>{state.error || translate("nav.filesView.error")}</span>
          <button aria-label={translate("nav.retry")} onClick={() => void loadDirectory(relativePath, true)} type="button"><RefreshCw size={12} /></button>
        </div>
      );
    }
    if (state.isLoading && !state.listing) {
      return <div className={styles.integrationLoading}><LoaderCircle className={styles.spin} size={14} /> {translate("nav.filesView.loading")}</div>;
    }
    if (!state.listing || state.listing.entries.length === 0) {
      return <div className={styles.integrationEmpty}>{translate("nav.filesView.empty")}</div>;
    }
    return (
      <>
        {state.listing.entries.map((entry) => {
          const isExpanded = expandedPaths.has(entry.path);
          return (
            <div key={entry.path}>
              <FileRow depth={depth} entry={entry} isExpanded={isExpanded} isLoading={Boolean(directories[entry.path]?.isLoading)} onToggle={() => toggleDirectory(entry)} onOpen={onOpenFile && workspaceId ? () => onOpenFile(workspaceId, entry.path) : undefined} />
              {entry.kind === "directory" && isExpanded ? renderDirectory(entry.path, depth + 1) : null}
            </div>
          );
        })}
        {state.listing.truncated ? <div className={styles.integrationNotice}>{translate("nav.filesView.truncated", { count: state.listing.limit })}</div> : null}
        {state.error !== null ? <div className={styles.integrationNotice}>{state.error || translate("nav.filesView.error")}</div> : null}
      </>
    );
  };

  return (
    <section aria-label={translate("nav.files")} className={styles.integrationView}>
      <div className={styles.integrationToolbar}>
        <label className={styles.integrationSelectLabel}>
          <span>{translate("nav.project")}</span>
          <select aria-label={translate("nav.filesView.project")} className={styles.integrationSelect} onChange={(event) => onSelectWorkspace?.(event.target.value)} value={workspace?.id ?? ""}>
            <option value="">{translate("nav.pickProject")}</option>
            {workspaces.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <button aria-label={translate("nav.filesView.refresh")} className={styles.integrationRefresh} disabled={!workspace} onClick={() => void loadDirectory("", true)} type="button"><RefreshCw size={13} /></button>
      </div>
      {!workspace ? <div className={styles.integrationEmpty}>{translate("nav.filesView.pick")}</div> : <div className={styles.integrationList}>{renderDirectory("", 0)}</div>}
    </section>
  );
}
