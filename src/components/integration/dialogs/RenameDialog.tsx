import { Pencil } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { DialogClose, DialogFooter, TerraDialog } from "../../overlays/Dialog";
import { Button } from "../../ui/Button";
import styles from "./ModalForms.module.css";

export type RenameTargetKind = "workspace" | "group";

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
  const [submitted, setSubmitted] = useState(false);
  const valid = value.trim().length > 0;
  const noun = kind === "workspace" ? "workspace" : "grupo";
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
      description={isCreate ? `Dê um nome para o novo ${noun}.` : `Escolha um novo nome para este ${noun}.`}
      onOpenChange={onOpenChange}
      open={open}
      title={`${isCreate ? "Novo" : "Renomear"} ${noun}`}
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="terra-rename-value">
            Nome
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
              Informe um nome antes de salvar.
            </span>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Cancelar
            </Button>
          </DialogClose>
          <Button leadingIcon={<Pencil aria-hidden="true" size={14} />} type="submit" variant="primary">
            {isCreate ? `Criar ${noun}` : "Salvar nome"}
          </Button>
        </DialogFooter>
      </form>
    </TerraDialog>
  );
}
