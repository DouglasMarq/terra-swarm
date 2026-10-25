import { Pencil } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { DialogClose, DialogFooter, TerraDialog } from "../../overlays/Dialog";
import { Button } from "../../ui/Button";
import { useT } from "../../../i18n";
import styles from "./ModalForms.module.css";

export type RenameTargetKind = "workspace" | "group" | "terminal";

export interface RenameDialogProps {
  isOpen: boolean;
  kind: RenameTargetKind;
  mode?: "rename" | "create";
  value: string;
  onChange: (value: string) => void;
  onOpenChange: (isOpen: boolean) => void;
  onSubmit: () => void | Promise<void>;
}

export function RenameDialog({
  kind,
  mode = "rename",
  onChange,
  onOpenChange,
  onSubmit,
  isOpen,
  value,
}: RenameDialogProps) {
  const translate = useT();
  const [isSubmitted, setSubmitted] = useState(false);
  const isValid = kind === "terminal" || value.trim().length > 0;
  const noun = translate(`rename.noun.${kind}`);
  const isCreate = mode === "create";

  useEffect(() => {
    if (!isOpen) setSubmitted(false);
  }, [isOpen]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!isValid) return;
    void onSubmit();
  }

  return (
    <TerraDialog
      className={styles.dialog}
      description={isCreate ? translate("rename.createDescription", { noun }) : translate("rename.description", { noun })}
      onOpenChange={onOpenChange}
      open={isOpen}
      title={isCreate ? translate("rename.createTitle", { noun }) : translate("rename.title", { noun })}
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="terra-rename-value">
            {translate("rename.name")}
          </label>
          <input
            aria-describedby={isSubmitted && !isValid ? "terra-rename-error" : undefined}
            aria-invalid={isSubmitted && !isValid}
            autoFocus
            className={styles.input}
            data-invalid={isSubmitted && !isValid ? "true" : undefined}
            id="terra-rename-value"
            onChange={(event) => onChange(event.target.value)}
            type="text"
            value={value}
          />
          {isSubmitted && !isValid ? (
            <span className={styles.error} id="terra-rename-error" role="alert">
              {translate("rename.required")}
            </span>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {translate("common.cancel")}
            </Button>
          </DialogClose>
          <Button leadingIcon={<Pencil aria-hidden="true" size={14} />} type="submit" variant="primary">
            {isCreate ? translate("rename.create", { noun }) : translate("rename.save")}
          </Button>
        </DialogFooter>
      </form>
    </TerraDialog>
  );
}
