import { lazy, Suspense, useEffect, useState } from "react";
import { FileText, RotateCw, Save } from "lucide-react";
import { useFileEditor } from "../../app/useFileEditor";
import { useT } from "../../i18n";
import { formatShortcut, type ShortcutDefinition } from "../../lib/platform/shortcuts";
import { useEditorStore } from "../../stores/editorStore";
import { DialogFooter, TerraDialog } from "../overlays/Dialog";
import { Button } from "../ui/Button";
import "./editor.css";

const SAVE_SHORTCUT: ShortcutDefinition = { key: "s", hasMeta: true, hasShift: false, hasCtrl: false, hasAlt: false };

const CodeEditor = lazy(() => import("./CodeEditor"));

const BYTES_PER_KIB = 1024;

export function FileEditorDialog() {
  const translate = useT();
  const target = useEditorStore((state) => state.target);
  const close = useEditorStore((state) => state.close);
  const editor = useFileEditor(target);
  const { file, loadError, saveError, generation } = editor;
  const hasConflict = editor.hasConflict;
  const isSaving = editor.isSaving;
  const isDirty = editor.isDirty;
  const [isConfirmingDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    setConfirmDiscard(false);
  }, [target]);

  const load = () => {
    setConfirmDiscard(false);
    void editor.load();
  };

  const save = async (shouldOverwrite = false) => {
    if (await editor.save(shouldOverwrite)) setConfirmDiscard(false);
  };

  const requestClose = () => {
    if (isDirty && !isConfirmingDiscard) {
      setConfirmDiscard(true);
      return;
    }
    close();
  };

  return (
    <TerraDialog
      className="terra-editor"
      open={target !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) requestClose();
      }}
      title={
        <span className="terra-editor-title">
          <FileText size={14} aria-hidden="true" />
          {target?.path ?? ""}
          {isDirty ? <span className="terra-editor-dirty" aria-label={translate("editor.unsaved")} title={translate("editor.unsaved")}>●</span> : null}
        </span>
      }
      description={file ? translate("editor.meta", { size: Math.max(1, Math.round(file.size / BYTES_PER_KIB)), shortcut: formatShortcut(SAVE_SHORTCUT) }) : translate("editor.loading")}
    >
      <div className="terra-editor-body">
        {loadError ? (
          <p className="terra-editor-message" role="alert">{loadError}</p>
        ) : file?.isBinary ? (
          <p className="terra-editor-message">{translate("editor.binary")}</p>
        ) : file ? (
          <Suspense fallback={<p className="terra-editor-message">{translate("editor.loading")}</p>}>
            <CodeEditor docKey={`${target?.workspaceId}:${target?.path}:${generation}`} path={file.path} initial={file.content} onChange={editor.setText} onSave={() => void save()} />
          </Suspense>
        ) : (
          <p className="terra-editor-message">{translate("editor.loading")}</p>
        )}
      </div>
      {saveError ? <p className="terra-editor-error" role="alert">{saveError}</p> : null}
      {isConfirmingDiscard ? <p className="terra-editor-error" role="alert">{translate("editor.discardPrompt")}</p> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={requestClose}>
          {isConfirmingDiscard ? translate("editor.discard") : translate("common.close")}
        </Button>
        {hasConflict ? (
          <>
            <Button type="button" onClick={load}>
              <RotateCw size={14} aria-hidden="true" />
              {translate("editor.reload")}
            </Button>
            <Button type="button" variant="danger" onClick={() => void save(true)} disabled={isSaving}>
              {translate("editor.overwrite")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="primary" onClick={() => void save()} disabled={!isDirty || isSaving || !file || file.isBinary}>
            <Save size={14} aria-hidden="true" />
            {isSaving ? translate("editor.saving") : translate("editor.save")}
          </Button>
        )}
      </DialogFooter>
    </TerraDialog>
  );
}
