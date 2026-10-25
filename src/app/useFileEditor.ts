import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { errorMessage } from "../lib/errors/errorMessage";
import { isIpcError } from "../lib/tauri/errors";
import type { EditorTarget } from "../stores/editorStore";
import type { WorkspaceFileContent } from "../domain/workspaceFiles.model";

export interface FileEditor {
  /** The file as last read or saved; null while loading or after a failed read. */
  file: WorkspaceFileContent | null;
  /** The editor's current text. */
  text: string;
  setText: (text: string) => void;
  isDirty: boolean;
  /** Changes on every read, so the editor starts a fresh document. */
  generation: number;
  loadError: string | null;
  saveError: string | null;
  /** The last save was refused because the file changed on disk since it was read. */
  hasConflict: boolean;
  isSaving: boolean;
  load: () => Promise<void>;
  /** Saves `text`; `overwrite` skips the changed-on-disk check. Resolves to whether it saved. */
  save: (overwrite?: boolean) => Promise<boolean>;
}

/** Read and save one workspace file for the built-in editor; reads again when the target changes. */
export function useFileEditor(target: EditorTarget | null): FileEditor {
  const [file, setFile] = useState<WorkspaceFileContent | null>(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    if (!target) return;
    setFile(null);
    setLoadError(null);
    setSaveError(null);
    setHasConflict(false);
    try {
      const next = await api.readWorkspaceFile(target.workspaceId, target.path);
      setFile(next);
      setText(next.content);
      setGeneration((value) => value + 1);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [target]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (overwrite = false): Promise<boolean> => {
    if (!target || !file || isSaving || file.binary) return false;
    setIsSaving(true);
    setSaveError(null);
    try {
      const saved = await api.writeWorkspaceFile(target.workspaceId, target.path, text, overwrite ? null : file.modified);
      setFile({ ...file, content: text, size: saved.size, modified: saved.modified });
      setHasConflict(false);
      return true;
    } catch (error) {
      setHasConflict(isIpcError(error, "changedOnDisk"));
      setSaveError(errorMessage(error));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const isDirty = file !== null && text !== file.content;
  return { file, text, setText, isDirty, generation, loadError, saveError, hasConflict, isSaving, load, save };
}
