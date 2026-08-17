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
      description="Defina um nome e, opcionalmente, a pasta de trabalho."
      onOpenChange={onOpenChange}
      open={open}
      title="Novo workspace"
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="terra-new-workspace-name">
            Nome
          </label>
          <input
            aria-describedby={submitted && !nameIsValid ? "terra-workspace-name-error" : undefined}
            aria-invalid={submitted && !nameIsValid}
            autoFocus
            className={styles.input}
            data-invalid={submitted && !nameIsValid ? "true" : undefined}
            id="terra-new-workspace-name"
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="meu-projeto"
            type="text"
            value={name}
          />
          {submitted && !nameIsValid ? (
            <span className={styles.error} id="terra-workspace-name-error" role="alert">
              Informe um nome para o workspace.
            </span>
          ) : (
            <span className={styles.hint}>Você poderá renomeá-lo depois.</span>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="terra-new-workspace-cwd">
            Pasta de trabalho <span className={styles.hint}>(opcional)</span>
          </label>
          <div className={styles.folderRow}>
            <input
              className={styles.folderInput}
              id="terra-new-workspace-cwd"
              onChange={(event) => onCwdChange(event.target.value)}
              placeholder="Diretório atual"
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
              Escolher
            </Button>
          </div>
        </div>

        {groupName ? <div className={styles.context}>Será criado no grupo “{groupName}”.</div> : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Cancelar
            </Button>
          </DialogClose>
          <Button type="submit" variant="primary">
            Criar workspace
          </Button>
        </DialogFooter>
      </form>
    </TerraDialog>
  );
}
