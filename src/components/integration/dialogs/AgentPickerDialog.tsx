import { Check, CircleAlert } from "lucide-react";

import type { AgentInfo } from "../../../types";
import { DialogFooter, TerraDialog } from "../../overlays/Dialog";
import { Button } from "../../ui/Button";
import styles from "./ModalForms.module.css";

export interface AgentPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: readonly AgentInfo[];
  saveDefault: boolean;
  onSaveDefaultChange: (save: boolean) => void;
  onChoose: (agentId: string) => void | Promise<void>;
}

/** Agent profile picker; unavailable profiles remain visible and explain why. */
export function AgentPickerDialog({
  agents,
  onChoose,
  onOpenChange,
  onSaveDefaultChange,
  open,
  saveDefault,
}: AgentPickerDialogProps) {
  return (
    <TerraDialog
      className={styles.dialog}
      description="Escolha o perfil que será executado neste terminal."
      onOpenChange={onOpenChange}
      open={open}
      title="Novo terminal"
    >
      <div aria-label="Perfis de agente" className={styles.agentList} role="list">
        {agents.length === 0 ? (
          <p className={styles.emptyAgents}>Nenhum perfil foi detectado ainda.</p>
        ) : (
          agents.map((agent) => (
            <button
              aria-label={`${agent.label}${agent.available ? "" : " (indisponível)"}`}
              className={styles.agentOption}
              disabled={!agent.available}
              key={agent.id}
              onClick={() => void onChoose(agent.id)}
              type="button"
            >
              <span aria-hidden="true" className={`pane-badge agent-${agent.id}`}>
                {agent.id}
              </span>
              <span className={styles.agentLabel}>{agent.label}</span>
              {agent.available ? (
                <Check aria-hidden="true" size={15} strokeWidth={1.8} />
              ) : (
                <span className={styles.agentMissing}>
                  <CircleAlert aria-hidden="true" size={13} /> indisponível
                </span>
              )}
            </button>
          ))
        )}
      </div>
      <label className={styles.pickerDefault}>
        <input
          checked={saveDefault}
          onChange={(event) => onSaveDefaultChange(event.target.checked)}
          type="checkbox"
        />
        <span>Usar como perfil padrão (atalhos não perguntarão novamente).</span>
      </label>
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
          Cancelar
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
