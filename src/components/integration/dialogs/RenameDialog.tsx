import { Pencil } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { DialogClose, DialogFooter, TerraDialog } from "../../overlays/Dialog";
import { Button } from "../../ui/Button";
import { useT } from "../../../i18n";
import styles from "./ModalForms.module.css";

export type RenameTargetKind = "workspace" | "group" | "terminal";

export interface RenameDialogProps {
  open: boolean;
  kind: RenameTargetKind;
  mode?: "rename" | "create";
  value: string;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void | Promise<void>;
}

export function RenameDialog({
  kind,
  mode = "rename",
  onChange,
  onOpenChange,
  onSubmit,
  open,
  value,
}: RenameDialogProps) {
  const t = useT();
  const [submitted, setSubmitted] = useState(false);
  const valid = value.trim().length > 0;
  const noun = t(`rename.noun.${kind}`);
  const isCreate = mode === "create";

  useEffect(() => {
    if (!open) setSubmitted(false);
  }, [open]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!valid) return;
    void onSubmit();
  }

  return (
    <TerraDialog
      className={styles.dialog}
      description={isCreate ? t("rename.createDescription", { noun }) : t("rename.description", { noun })}
      onOpenChange={onOpenChange}
      open={open}
      title={isCreate ? t("rename.createTitle", { noun }) : t("rename.title", { noun })}
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="terra-rename-value">
            {t("rename.name")}
          </label>
          <input
            aria-describedby={submitted && !valid ? "terra-rename-error" : undefined}
            aria-invalid={submitted && !valid}
            autoFocus
            className={styles.input}
            data-invalid={submitted && !valid ? "true" : undefined}
            id="terra-rename-value"
            onChange={(event) => onChange(event.target.value)}
            type="text"
            value={value}
          />
          {submitted && !valid ? (
            <span className={styles.error} id="terra-rename-error" role="alert">
              {t("rename.required")}
            </span>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t("common.cancel")}
            </Button>
          </DialogClose>
          <Button leadingIcon={<Pencil aria-hidden="true" size={14} />} type="submit" variant="primary">
            {isCreate ? t("rename.create", { noun }) : t("rename.save")}
          </Button>
        </DialogFooter>
      </form>
    </TerraDialog>
  );
}
