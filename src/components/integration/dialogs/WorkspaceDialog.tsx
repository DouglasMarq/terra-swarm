import { t } from "../../../i18n";
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  cwd: string;
  groupName?: string | null;
  onNameChange: (name: string) => void;
  onCwdChange: (cwd: string) => void;
  onBrowse: () => void | Promise<void>;
  onSubmit: () => void | Promise<void>;
}

/** Controlled workspace form used by both the home launcher and navigator. */
export function WorkspaceDialog({
  cwd,
  groupName,
  name,
  onBrowse,
  onCwdChange,
  onNameChange,
  onOpenChange,
  onSubmit,
  open,
}: WorkspaceDialogProps) {
  const [submitted, setSubmitted] = useState(false);
  const nameIsValid = name.trim().length > 0;

  useEffect(() => {
    if (!open) setSubmitted(false);
  }, [open]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!nameIsValid) return;
    void onSubmit();
  }

  return (
    <TerraDialog
      className={styles.dialog}
      description={t("dialogs.workspace.description")}
      onOpenChange={onOpenChange}
      open={open}
      title={t("shell.newWorkspace")}
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="terra-new-workspace-name">
            {t("rename.name")}
          </label>
          <input
            aria-describedby={submitted && !nameIsValid ? "terra-workspace-name-error" : undefined}
            aria-invalid={submitted && !nameIsValid}
            autoFocus
            className={styles.input}
            data-invalid={submitted && !nameIsValid ? "true" : undefined}
            id="terra-new-workspace-name"
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={t("dialogs.workspace.namePlaceholder")}
            type="text"
            value={name}
          />
          {submitted && !nameIsValid ? (
            <span className={styles.error} id="terra-workspace-name-error" role="alert">
              {t("dialogs.workspace.nameRequired")}
            </span>
          ) : (
            <span className={styles.hint}>{t("dialogs.workspace.renameLater")}</span>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="terra-new-workspace-cwd">
            {t("dialogs.workspace.folder")} <span className={styles.hint}>{t("dialogs.workspace.optional")}</span>
          </label>
          <div className={styles.folderRow}>
            <input
              className={styles.folderInput}
              id="terra-new-workspace-cwd"
              onChange={(event) => onCwdChange(event.target.value)}
              placeholder={t("dialogs.workspace.currentFolder")}
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
              {t("dialogs.workspace.browse")}
            </Button>
          </div>
        </div>

        {groupName ? <div className={styles.context}>{t("dialogs.workspace.inGroup", { name: groupName })}</div> : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t("common.cancel")}
            </Button>
          </DialogClose>
          <Button type="submit" variant="primary">
            {t("dialogs.workspace.create")}
          </Button>
        </DialogFooter>
      </form>
    </TerraDialog>
  );
}
