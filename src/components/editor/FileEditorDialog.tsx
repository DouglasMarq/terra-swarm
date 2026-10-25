import { lazy, Suspense, useEffect, useState } from "react";
import { FileText, RotateCw, Save } from "lucide-react";
import { useFileEditor } from "../../app/useFileEditor";
import { useT } from "../../i18n";
import { formatShortcut, type ShortcutDefinition } from "../../lib/platform/shortcuts";
import { useEditorStore } from "../../stores/editorStore";
import { DialogFooter, TerraDialog } from "../overlays/Dialog";
import { Button } from "../ui/Button";
import "./editor.css";

/** CodeMirror's `Mod-s`: Cmd on macOS, Ctrl elsewhere. */
const SAVE_SHORTCUT: ShortcutDefinition = { key: "s", meta: true, shift: false, ctrl: false, alt: false };

const CodeEditor = lazy(() => import("./CodeEditor"));

const BYTES_PER_KIB = 1024;

/**
 * A light editor for one project file, opened from the Files view. Saving
 * refuses to overwrite a file an agent changed meanwhile, unless asked to.
 */
export function FileEditorDialog() {
  const t = useT();
  const target = useEditorStore((state) => state.target);
  const close = useEditorStore((state) => state.close);
  const editor = useFileEditor(target);
  const { file, loadError, saveError, generation } = editor;
  const conflict = editor.hasConflict;
  const saving = editor.isSaving;
  const dirty = editor.isDirty;
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    setConfirmDiscard(false);
  }, [target]);

  const load = () => {
    setConfirmDiscard(false);
    void editor.load();
  };

  const save = async (overwrite = false) => {
    if (await editor.save(overwrite)) setConfirmDiscard(false);
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
      description={file ? t("editor.meta", { size: Math.max(1, Math.round(file.size / BYTES_PER_KIB)), shortcut: formatShortcut(SAVE_SHORTCUT) }) : t("editor.loading")}
    >
      <div className="terra-editor-body">
        {loadError ? (
          <p className="terra-editor-message" role="alert">{loadError}</p>
        ) : file?.binary ? (
          <p className="terra-editor-message">{t("editor.binary")}</p>
        ) : file ? (
          <Suspense fallback={<p className="terra-editor-message">{t("editor.loading")}</p>}>
            <CodeEditor docKey={`${target?.workspaceId}:${target?.path}:${generation}`} path={file.path} initial={file.content} onChange={editor.setText} onSave={() => void save()} />
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
            <Button type="button" onClick={load}>
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
