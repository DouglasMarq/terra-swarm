import { useState } from "react";
import { api } from "../api";
import { translateNow } from "../i18n";
import { basename } from "../lib/path/basename";
import { openDialog } from "../lib/tauri/system";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useUiStore } from "../stores/uiStore";

export function useWorkspaceCreator(refresh: () => Promise<void>) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);

  const pickFolder = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false });
      if (typeof dir !== "string") return;
      setCwd(dir);
      if (name) return;
      const base = basename(dir);
      if (base) setName(base);
    } catch (err) {
      console.error("folder picker failed:", err);
    }
  };

  const reset = () => {
    setOpen(false);
    setName("");
    setCwd("");
    setGroupId(null);
  };

  const create = async () => {
    try {
      const ws = await api.createWorkspace(name.trim() || translateNow("app.defaultWorkspaceName"), cwd);
      if (groupId) {
        await api.setWorkspaceGroup(ws.id, groupId).catch((error) => {
          console.error(`failed to assign new workspace ${ws.id} to group:`, error);
        });
      }
      reset();
      await refresh();
      useUiStore.getState().setActiveId(ws.id);
    } catch (err) {
      console.error("failed to create workspace:", err);
      useTerminalRuntimeStore.getState().pushSystemNotification(translateNow("app.createWorkspaceFailed", { detail: String(err) }));
    }
  };

  const openCreator = (targetGroupId: string | null = null) => {
    setGroupId(targetGroupId);
    setOpen(true);
  };

  return { open, name, cwd, groupId, setOpen, setName, setCwd, pickFolder, create, openCreator };
}
