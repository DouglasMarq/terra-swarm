import { useState } from "react";
import { openDialog, saveDialog } from "../lib/tauri/system";
import { api } from "../api";
import { translateNow } from "../i18n";
import { errorMessage } from "../lib/errors/errorMessage";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";
import type { TerminalSessions } from "./useTerminalSessions";

export type SnapshotOperation = "exporting" | "importing";

export interface SnapshotFeedback {
  kind: "success" | "error";
  message: string;
  backupPath?: string | null;
  pathKind?: "backup" | "file";
}

export function useSnapshotTransfer(sessions: Pick<TerminalSessions, "forgetAll">, refresh: () => Promise<void>) {
  const [operation, setOperation] = useState<SnapshotOperation | null>(null);
  const [feedback, setFeedback] = useState<SnapshotFeedback | null>(null);
  const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);

  const exportSnapshot = async () => {
    if (operation) return;
    setOperation("exporting");
    try {
      const path = await saveDialog({
        title: translateNow("app.exportDialogTitle"),
        defaultPath: "terra-swarm-snapshot.json",
        filters: [{ name: translateNow("app.snapshotFileType"), extensions: ["json"] }],
      });
      if (typeof path !== "string" || !path.trim()) return;
      setFeedback(null);
      const transfer = await api.exportWorkspaceSnapshot(path);
      setFeedback({
        kind: "success",
        message: translateNow("app.snapshotExported", { workspaces: transfer.workspaceCount, terminals: transfer.terminalCount }),
        backupPath: transfer.path,
        pathKind: "file",
      });
    } catch (error) {
      console.error("workspace snapshot export failed:", error);
      setFeedback({ kind: "error", message: errorMessage(error, translateNow("app.snapshotFailed")) });
    } finally {
      setOperation(null);
    }
  };

  const pickImport = async () => {
    if (operation || pendingImportPath) return;
    try {
      const path = await openDialog({
        title: translateNow("app.importDialogTitle"),
        multiple: false,
        directory: false,
        filters: [{ name: translateNow("app.snapshotFileType"), extensions: ["json"] }],
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
        message: translateNow("app.snapshotImported", { workspaces: transfer.workspaceCount, terminals: transfer.suspendedTerminalCount }),
        backupPath: transfer.backupPath,
        pathKind: "backup",
      });
    } catch (error) {
      console.error("workspace snapshot import failed:", error);
      setFeedback({ kind: "error", message: errorMessage(error, translateNow("app.snapshotFailed")) });
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
