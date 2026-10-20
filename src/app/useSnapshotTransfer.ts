import { useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { t } from "../i18n";
import type { SnapshotFeedback, SnapshotOperation } from "../components/integration/settings/SettingsPanels";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import type { TerminalSessions } from "./useTerminalSessions";

function describeSnapshotError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return t("app.snapshotFailed");
}

/** Export and import of the whole workspace store (Settings → Data & backup). */
export function useSnapshotTransfer(sessions: TerminalSessions, refresh: () => Promise<void>) {
  const [operation, setOperation] = useState<SnapshotOperation | null>(null);
  const [feedback, setFeedback] = useState<SnapshotFeedback | null>(null);
  /** A file was picked and waits for the user to confirm the import. */
  const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);

  const exportSnapshot = async () => {
    if (operation) return;
    setOperation("exporting");
    try {
      const path = await saveDialog({
        title: t("app.exportDialogTitle"),
        defaultPath: "terra-swarm-snapshot.json",
        filters: [{ name: t("app.snapshotFileType"), extensions: ["json"] }],
      });
      // A cancelled picker is a true no-op: no IPC call, feedback kept.
      if (typeof path !== "string" || !path.trim()) return;
      setFeedback(null);
      const transfer = await api.exportWorkspaceSnapshot(path);
      setFeedback({
        kind: "success",
        message: t("app.snapshotExported", { workspaces: transfer.workspaceCount, terminals: transfer.terminalCount }),
        backupPath: transfer.path,
        pathKind: "file",
      });
    } catch (error) {
      console.error("workspace snapshot export failed:", error);
      setFeedback({ kind: "error", message: describeSnapshotError(error) });
    } finally {
      setOperation(null);
    }
  };

  /** Ask for a file; the import itself waits for confirmation. */
  const pickImport = async () => {
    if (operation || pendingImportPath) return;
    try {
      const path = await openDialog({
        title: t("app.importDialogTitle"),
        multiple: false,
        directory: false,
        filters: [{ name: t("app.snapshotFileType"), extensions: ["json"] }],
      });
      if (typeof path !== "string" || !path.trim()) return;
      setPendingImportPath(path);
    } catch (error) {
      console.error("workspace snapshot picker failed:", error);
    }
  };

  const confirmImport = async () => {
    const path = pendingImportPath;
    if (operation || !path || !path.trim()) return;
    setPendingImportPath(null);
    setOperation("importing");
    try {
      setFeedback(null);
      const transfer = await api.importWorkspaceSnapshot(path);
      // Import is metadata-only and the backend stopped every PTY before
      // replacing the store. Drop stale runtime state without respawning the
      // imported sessions; the user resumes them explicitly.
      const runtime = useTerminalRuntimeStore.getState();
      runtime.clearTerminals(sessions.forgetAll());
      runtime.clearAllNotifications();
      runtime.setExited({});
      runtime.setContextUsage({});
      runtime.setTitles({});
      runtime.setResumeItems(null);
      runtime.setResumeSavedAt(null);
      useUiStore.getState().setExpandedId(null);
      useUiStore.getState().setFocusedId(null);
      await refresh();
      setFeedback({
        kind: "success",
        message: t("app.snapshotImported", { workspaces: transfer.workspaceCount, terminals: transfer.suspendedTerminalCount }),
        backupPath: transfer.backupPath,
        pathKind: "backup",
      });
    } catch (error) {
      console.error("workspace snapshot import failed:", error);
      setFeedback({ kind: "error", message: describeSnapshotError(error) });
    } finally {
      setOperation(null);
    }
  };

  return {
    operation,
    feedback,
    pendingImportPath,
    exportSnapshot,
    pickImport,
    confirmImport,
    cancelImport: () => setPendingImportPath(null),
  };
}
