import { useState } from "react";
import { useT } from "../../../i18n";
import type { WorktreeStatus } from "../../../types";
import { DialogFooter, TerraDialog } from "../../overlays/Dialog";
import { Button } from "../../ui/Button";
import styles from "./ModalForms.module.css";

export interface WorktreeCloseDialogProps {
  /** The agent being closed and its worktree; `null` closes the dialog. */
  target: { label: string; status: WorktreeStatus } | null;
  onKeep: () => void;
  onDelete: (deleteBranch: boolean) => void;
  onCancel: () => void;
  /** Open the review of the worktree instead of closing. */
  onReview?: () => void;
}

/** Closing an isolated agent whose work is not merged anywhere yet. */
export function WorktreeCloseDialog({ target, onKeep, onDelete, onCancel, onReview }: WorktreeCloseDialogProps) {
  const t = useT();
  const [deleteBranch, setDeleteBranch] = useState(false);
  const status = target?.status;
  return (
    <TerraDialog
      className={styles.dialog}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t("dialogs.worktree.title", { name: target?.label ?? "" })}
      description={t("dialogs.worktree.description", { branch: status?.branch ?? "" })}
    >
      {status ? (
        <div className={styles.worktreeFacts}>
          {status.dirty.length > 0 ? (
            <>
              <span>{t("dialogs.worktree.dirty", { count: status.dirty.length })}</span>
              <ul className={styles.worktreeFiles}>
                {status.dirty.slice(0, 20).map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </>
          ) : null}
          {status.ahead > 0 ? <span>{t("dialogs.worktree.ahead", { count: status.ahead, base: status.base })}</span> : null}
        </div>
      ) : null}
      <label className={styles.pickerDefault}>
        <input checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} type="checkbox" />
        <span>{t("dialogs.worktree.deleteBranch", { branch: status?.branch ?? "" })}</span>
      </label>
      <DialogFooter>
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("common.cancel")}
        </Button>
        {onReview ? (
          <Button onClick={onReview} type="button" variant="ghost">
            {t("review.open")}
          </Button>
        ) : null}
        <Button onClick={onKeep} type="button">
          {t("dialogs.worktree.keep")}
        </Button>
        <Button onClick={() => onDelete(deleteBranch)} type="button" variant="danger">
          {t("dialogs.worktree.delete")}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
