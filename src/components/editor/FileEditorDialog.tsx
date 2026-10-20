import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { FileText, RotateCw, Save } from "lucide-react";
import { api } from "../../api";
import { useT } from "../../i18n";
import { errorMessage } from "../../lib/errors/errorMessage";
import { formatShortcut, type ShortcutDefinition } from "../../lib/platform/shortcuts";
import { useEditorStore } from "../../stores/editorStore";
import type { WorkspaceFileContent } from "../../types";
import { DialogFooter, TerraDialog } from "../overlays/Dialog";
import { Button } from "../ui/Button";
import "./editor.css";

/** CodeMirror's `Mod-s`: Cmd on macOS, Ctrl elsewhere. */
const SAVE_SHORTCUT: ShortcutDefinition = { key: "s", meta: true, shift: false, ctrl: false, alt: false };

const CodeEditor = lazy(() => import("./CodeEditor"));

/**
 * A light editor for one project file, opened from the Files view. Saving
 * refuses to overwrite a file an agent changed meanwhile, unless asked to.
 */
export function FileEditorDialog() {
  const t = useT();
  const target = useEditorStore((state) => state.target);
  const close = useEditorStore((state) => state.close);
  const [file, setFile] = useState<WorkspaceFileContent | null>(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [generation, setGeneration] = useState(0);
  const dirty = file !== null && text !== file.content;

  const load = useCallback(async () => {
    if (!target) return;
    setFile(null);
    setLoadError(null);
    setSaveError(null);
    setConflict(false);
    setConfirmDiscard(false);
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

  const save = async (overwrite = false) => {
    if (!target || !file || saving || file.binary) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.writeWorkspaceFile(target.workspaceId, target.path, text, overwrite ? null : file.modified);
      setFile({ ...file, content: text, size: saved.size, modified: saved.modified });
      setConflict(false);
      // Nothing is left to lose, so the close warning no longer applies.
      setConfirmDiscard(false);
    } catch (error) {
      const message = errorMessage(error);
      setConflict(message.includes("changed on disk"));
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    close();
  };

  return (
    <TerraDialog
      className="terra-editor"
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      title={
        <span className="terra-editor-title">
          <FileText size={14} aria-hidden="true" />
          {target?.path ?? ""}
          {dirty ? <span className="terra-editor-dirty" aria-label={t("editor.unsaved")} title={t("editor.unsaved")}>●</span> : null}
        </span>
      }
      description={file ? t("editor.meta", { size: Math.max(1, Math.round(file.size / 1024)), shortcut: formatShortcut(SAVE_SHORTCUT) }) : t("editor.loading")}
    >
      <div className="terra-editor-body">
        {loadError ? (
          <p className="terra-editor-message" role="alert">{loadError}</p>
        ) : file?.binary ? (
          <p className="terra-editor-message">{t("editor.binary")}</p>
        ) : file ? (
          <Suspense fallback={<p className="terra-editor-message">{t("editor.loading")}</p>}>
            <CodeEditor docKey={`${target?.workspaceId}:${target?.path}:${generation}`} path={file.path} initial={file.content} onChange={setText} onSave={() => void save()} />
          </Suspense>
        ) : (
          <p className="terra-editor-message">{t("editor.loading")}</p>
        )}
      </div>
      {saveError ? <p className="terra-editor-error" role="alert">{saveError}</p> : null}
      {confirmDiscard ? <p className="terra-editor-error" role="alert">{t("editor.discardPrompt")}</p> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={requestClose}>
          {confirmDiscard ? t("editor.discard") : t("common.close")}
        </Button>
        {conflict ? (
          <>
            <Button type="button" onClick={() => void load()}>
              <RotateCw size={14} aria-hidden="true" />
              {t("editor.reload")}
            </Button>
            <Button type="button" variant="danger" onClick={() => void save(true)} disabled={saving}>
              {t("editor.overwrite")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="primary" onClick={() => void save()} disabled={!dirty || saving || !file || file.binary}>
            <Save size={14} aria-hidden="true" />
            {saving ? t("editor.saving") : t("editor.save")}
          </Button>
        )}
      </DialogFooter>
    </TerraDialog>
  );
}
