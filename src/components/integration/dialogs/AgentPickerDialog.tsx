import { t } from "../../../i18n";
import { Check, CircleAlert } from "lucide-react";

import type { AgentInfo } from "../../../types";
import { DialogFooter, TerraDialog } from "../../overlays/Dialog";
import { Button } from "../../ui/Button";
import styles from "./ModalForms.module.css";

export interface AgentPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: readonly AgentInfo[];
  /** Existing quick-add default, when the picker was opened from the panel. */
  defaultAgent?: string | null;
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
  defaultAgent = null,
}: AgentPickerDialogProps) {
  return (
    <TerraDialog
      className={styles.dialog}
      description={t("dialogs.picker.description")}
      onOpenChange={onOpenChange}
      open={open}
      title={t("palette.newAgent")}
    >
      <div aria-label={t("dialogs.picker.profiles")} className={styles.agentList} role="list">
        {agents.length === 0 ? (
          <p className={styles.emptyAgents}>{t("settingsPanels.detectedNone")}</p>
        ) : (
          agents.map((agent) => (
            <button
              aria-label={agent.available ? agent.label : t("dialogs.picker.unavailableNamed", { name: agent.label })}
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
                  <CircleAlert aria-hidden="true" size={13} /> {t("dialogs.picker.unavailable")}
                </span>
              )}
            </button>
          ))
        )}
      </div>
      {defaultAgent ? (
        <p className={styles.pickerDefaultHint}>
          Perfil padrão atual: <strong>{defaultAgent}</strong>
        </p>
      ) : null}
      <label className={styles.pickerDefault}>
        <input
          checked={saveDefault}
          onChange={(event) => onSaveDefaultChange(event.target.checked)}
          type="checkbox"
        />
        <span>{t("dialogs.picker.saveDefault")}</span>
      </label>
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
          {t("common.cancel")}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
