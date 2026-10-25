import { useT } from "../../../i18n";
import { Check, CircleAlert } from "lucide-react";

import { AGENT_ROLES, isAgentRole } from "../../../domain/agentRoles";
import type { AgentInfo, AgentRole } from "../../../domain/agent.model";
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
  /** The project is a git repository, so the agent can get its own worktree. */
  canIsolate?: boolean;
  isolate?: boolean;
  onIsolateChange?: (isolate: boolean) => void;
  /** Team role for the new agent; the select shows when this is handled. */
  role?: AgentRole | null;
  onRoleChange?: (role: AgentRole | null) => void;
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
  canIsolate = false,
  isolate = false,
  onIsolateChange,
  role = null,
  onRoleChange,
}: AgentPickerDialogProps) {
  const t = useT();
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
          {t("dialogs.currentDefault")} <strong>{defaultAgent}</strong>
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
      {canIsolate && onIsolateChange ? (
        <label className={styles.pickerDefault}>
          <input checked={isolate} onChange={(event) => onIsolateChange(event.target.checked)} type="checkbox" />
          <span>
            {t("dialogs.picker.isolate")}
            <small className={styles.pickerHint}>{t("dialogs.picker.isolateHint")}</small>
          </span>
        </label>
      ) : null}
      {onRoleChange ? (
        <label className={styles.pickerDefault}>
          <span>
            {t("dialogs.picker.role")}
            <small className={styles.pickerHint}>{t("dialogs.picker.roleHint")}</small>
          </span>
          <select
            className={styles.pickerRole}
            aria-label={t("dialogs.picker.role")}
            value={role ?? ""}
            onChange={(event) => onRoleChange(isAgentRole(event.target.value) ? event.target.value : null)}
          >
            <option value="">{t("roles.none")}</option>
            {AGENT_ROLES.map((value) => (
              <option key={value} value={value}>{t(`roles.${value}`)}</option>
            ))}
          </select>
        </label>
      ) : null}
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
          {t("common.cancel")}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
