import { useT } from "../../../i18n";
import { Check, CircleAlert } from "lucide-react";

import { AGENT_ROLES, isAgentRole } from "../../../domain/agentRoles";
import type { AgentInfo, AgentRole } from "../../../domain/agent.model";
import { DialogFooter, TerraDialog } from "../../overlays/Dialog";
import { Button } from "../../ui/Button";
import styles from "./ModalForms.module.css";

export interface AgentPickerDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  agents: readonly AgentInfo[];
  defaultAgent?: string | null;
  shouldSaveDefault: boolean;
  onSaveDefaultChange: (shouldSave: boolean) => void;
  onChoose: (agentId: string) => void | Promise<void>;
  canIsolate?: boolean;
  shouldIsolate?: boolean;
  onIsolateChange?: (shouldIsolate: boolean) => void;
  role?: AgentRole | null;
  onRoleChange?: (role: AgentRole | null) => void;
}

export function AgentPickerDialog({
  agents,
  onChoose,
  onOpenChange,
  onSaveDefaultChange,
  isOpen,
  shouldSaveDefault,
  defaultAgent = null,
  canIsolate = false,
  shouldIsolate = false,
  onIsolateChange,
  role = null,
  onRoleChange,
}: AgentPickerDialogProps) {
  const translate = useT();
  return (
    <TerraDialog
      className={styles.dialog}
      description={translate("dialogs.picker.description")}
      onOpenChange={onOpenChange}
      open={isOpen}
      title={translate("palette.newAgent")}
    >
      <div aria-label={translate("dialogs.picker.profiles")} className={styles.agentList} role="list">
        {agents.length === 0 ? (
          <p className={styles.emptyAgents}>{translate("settingsPanels.detectedNone")}</p>
        ) : (
          agents.map((agent) => (
            <button
              aria-label={agent.isAvailable ? agent.label : translate("dialogs.picker.unavailableNamed", { name: agent.label })}
              className={styles.agentOption}
              disabled={!agent.isAvailable}
              key={agent.id}
              onClick={() => void onChoose(agent.id)}
              type="button"
            >
              <span aria-hidden="true" className={`pane-badge agent-${agent.id}`}>
                {agent.id}
              </span>
              <span className={styles.agentLabel}>{agent.label}</span>
              {agent.isAvailable ? (
                <Check aria-hidden="true" size={15} strokeWidth={1.8} />
              ) : (
                <span className={styles.agentMissing}>
                  <CircleAlert aria-hidden="true" size={13} /> {translate("dialogs.picker.unavailable")}
                </span>
              )}
            </button>
          ))
        )}
      </div>
      {defaultAgent ? (
        <p className={styles.pickerDefaultHint}>
          {translate("dialogs.currentDefault")} <strong>{defaultAgent}</strong>
        </p>
      ) : null}
      <label className={styles.pickerDefault}>
        <input
          checked={shouldSaveDefault}
          onChange={(event) => onSaveDefaultChange(event.target.checked)}
          type="checkbox"
        />
        <span>{translate("dialogs.picker.saveDefault")}</span>
      </label>
      {canIsolate && onIsolateChange ? (
        <label className={styles.pickerDefault}>
          <input checked={shouldIsolate} onChange={(event) => onIsolateChange(event.target.checked)} type="checkbox" />
          <span>
            {translate("dialogs.picker.isolate")}
            <small className={styles.pickerHint}>{translate("dialogs.picker.isolateHint")}</small>
          </span>
        </label>
      ) : null}
      {onRoleChange ? (
        <label className={styles.pickerDefault}>
          <span>
            {translate("dialogs.picker.role")}
            <small className={styles.pickerHint}>{translate("dialogs.picker.roleHint")}</small>
          </span>
          <select
            className={styles.pickerRole}
            aria-label={translate("dialogs.picker.role")}
            value={role ?? ""}
            onChange={(event) => onRoleChange(isAgentRole(event.target.value) ? event.target.value : null)}
          >
            <option value="">{translate("roles.none")}</option>
            {AGENT_ROLES.map((value) => (
              <option key={value} value={value}>{translate(`roles.${value}`)}</option>
            ))}
          </select>
        </label>
      ) : null}
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
          {translate("common.cancel")}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
