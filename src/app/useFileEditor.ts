import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { errorMessage } from "../lib/errors/errorMessage";
import { isIpcError } from "../lib/tauri/errors";
import type { EditorTarget } from "../stores/editorStore";
import type { WorkspaceFileContent } from "../domain/workspaceFiles.model";

export interface FileEditor {
  file: WorkspaceFileContent | null;
  text: string;
  setText: (text: string) => void;
  isDirty: boolean;
  generation: number;
  loadError: string | null;
  saveError: string | null;
  hasConflict: boolean;
  isSaving: boolean;
  load: () => Promise<void>;
  save: (shouldOverwrite?: boolean) => Promise<boolean>;
}

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

  const save = async (shouldOverwrite = false): Promise<boolean> => {
    if (!target || !file || isSaving || file.isBinary) return false;
    setIsSaving(true);
    setSaveError(null);
    try {
      const saved = await api.writeWorkspaceFile({
        workspaceId: target.workspaceId,
        relativePath: target.path,
        content: text,
        expectedModified: shouldOverwrite ? null : file.modified,
      });
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
