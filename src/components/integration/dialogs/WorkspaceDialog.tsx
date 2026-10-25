import { useT } from "../../../i18n";
import { FolderOpen } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import {
  DialogClose,
  DialogFooter,
  TerraDialog,
} from "../../overlays/Dialog";
import { Button } from "../../ui/Button";
import styles from "./ModalForms.module.css";

export interface WorkspaceDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  name: string;
  cwd: string;
  groupName?: string | null;
  onNameChange: (name: string) => void;
  onCwdChange: (cwd: string) => void;
  onBrowse: () => void | Promise<void>;
  onSubmit: () => void | Promise<void>;
}

export function WorkspaceDialog({
  cwd,
  groupName,
  name,
  onBrowse,
  onCwdChange,
  onNameChange,
  onOpenChange,
  onSubmit,
  isOpen,
}: WorkspaceDialogProps) {
  const translate = useT();
  const [isSubmitted, setSubmitted] = useState(false);
  const isNameValid = name.trim().length > 0;

  useEffect(() => {
    if (!isOpen) setSubmitted(false);
  }, [isOpen]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!isNameValid) return;
    void onSubmit();
  }

  return (
    <TerraDialog
      className={styles.dialog}
      description={translate("dialogs.workspace.description")}
      onOpenChange={onOpenChange}
      open={isOpen}
      title={translate("shell.newWorkspace")}
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="terra-new-workspace-name">
            {translate("rename.name")}
          </label>
          <input
            aria-describedby={isSubmitted && !isNameValid ? "terra-workspace-name-error" : undefined}
            aria-invalid={isSubmitted && !isNameValid}
            autoFocus
            className={styles.input}
            data-invalid={isSubmitted && !isNameValid ? "true" : undefined}
            id="terra-new-workspace-name"
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={translate("dialogs.workspace.namePlaceholder")}
            type="text"
            value={name}
          />
          {isSubmitted && !isNameValid ? (
            <span className={styles.error} id="terra-workspace-name-error" role="alert">
              {translate("dialogs.workspace.nameRequired")}
            </span>
          ) : (
            <span className={styles.hint}>{translate("dialogs.workspace.renameLater")}</span>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="terra-new-workspace-cwd">
            {translate("dialogs.workspace.folder")} <span className={styles.hint}>{translate("dialogs.workspace.optional")}</span>
          </label>
          <div className={styles.folderRow}>
            <input
              className={styles.folderInput}
              id="terra-new-workspace-cwd"
              onChange={(event) => onCwdChange(event.target.value)}
              placeholder={translate("dialogs.workspace.currentFolder")}
              type="text"
              value={cwd}
            />
            <Button
              className={styles.browseButton}
              leadingIcon={<FolderOpen aria-hidden="true" size={14} />}
              onClick={() => void onBrowse()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {translate("dialogs.workspace.browse")}
            </Button>
          </div>
        </div>

        {groupName ? <div className={styles.context}>{translate("dialogs.workspace.inGroup", { name: groupName })}</div> : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {translate("common.cancel")}
            </Button>
          </DialogClose>
          <Button type="submit" variant="primary">
            {translate("dialogs.workspace.create")}
          </Button>
        </DialogFooter>
      </form>
    </TerraDialog>
  );
}
