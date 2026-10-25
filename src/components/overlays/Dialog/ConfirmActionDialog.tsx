import { useT } from "../../../i18n";
import { AlertTriangle } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../ui/Button";
import {
  DialogClose,
  DialogFooter,
  TerraDialog,
} from "./Dialog";
import { getConfirmationCopy, type ActionIntent } from "./dialogModel";
import styles from "./ConfirmActionDialog.module.css";

export interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  intent?: ActionIntent;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
}

/**
 * A controlled confirmation dialog. The callback is intentionally unreachable
 * until the user presses the explicit confirmation action.
 */
export function ConfirmActionDialog({
  busy = false,
  cancelLabel,
  confirmLabel,
  description,
  intent = "destructive",
  onConfirm,
  onOpenChange,
  open,
  title,
}: ConfirmActionDialogProps) {
  const translate = useT();
  const [submitting, setSubmitting] = useState(false);
  const copy = getConfirmationCopy(intent, translate);
  const isBusy = busy || submitting;

  async function handleConfirm() {
    if (isBusy) return;

    setSubmitting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <TerraDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? copy.title}
      description={
        <span className={styles.descriptionWithIcon}>
          {intent === "destructive" ? (
            <AlertTriangle aria-hidden="true" className={styles.warningIcon} size={18} strokeWidth={1.8} />
          ) : null}
          <span>{description}</span>
        </span>
      }
      className="terra-confirm-dialog"
    >
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="ghost" disabled={isBusy}>
            {cancelLabel ?? translate("common.cancel")}
          </Button>
        </DialogClose>
        <Button
          type="button"
          variant={intent === "destructive" ? "danger" : "primary"}
          loading={isBusy}
          onClick={() => void handleConfirm()}
        >
          {confirmLabel ?? copy.confirmLabel}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
