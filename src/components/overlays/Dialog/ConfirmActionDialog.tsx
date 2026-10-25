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
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title?: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  intent?: ActionIntent;
  onConfirm: () => void | Promise<void>;
  isBusy?: boolean;
}

export function ConfirmActionDialog({
  isBusy = false,
  cancelLabel,
  confirmLabel,
  description,
  intent = "destructive",
  onConfirm,
  onOpenChange,
  isOpen,
  title,
}: ConfirmActionDialogProps) {
  const translate = useT();
  const [isSubmitting, setSubmitting] = useState(false);
  const copy = getConfirmationCopy(intent, translate);
  const isBusyOrSubmitting = isBusy || isSubmitting;

  async function handleConfirm() {
    if (isBusyOrSubmitting) return;

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
      open={isOpen}
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
          <Button type="button" variant="ghost" disabled={isBusyOrSubmitting}>
            {cancelLabel ?? translate("common.cancel")}
          </Button>
        </DialogClose>
        <Button
          type="button"
          variant={intent === "destructive" ? "danger" : "primary"}
          isLoading={isBusyOrSubmitting}
          onClick={() => void handleConfirm()}
        >
          {confirmLabel ?? copy.confirmLabel}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
