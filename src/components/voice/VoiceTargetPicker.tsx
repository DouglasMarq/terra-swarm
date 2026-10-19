import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useT } from "../../i18n";

export type VoiceTargetStatus = "working" | "attention" | "exited" | "suspended";

export interface VoiceTargetAgent {
  id: string;
  primary: string;
  tag: string;
  status: VoiceTargetStatus;
  detail: string;
}

export interface VoiceTargetProject {
  id: string;
  name: string;
  agents: VoiceTargetAgent[];
}

export interface VoiceTargetPickerProps {
  projects: readonly VoiceTargetProject[];
  targetId: string | null;
  onChange: (terminalId: string) => void;
}

/**
 * "Send to" chip for the voice capsule. Opens a project → agent tree; an
 * exited agent stays selectable and is resumed before it receives the prompt.
 */
export function VoiceTargetPicker({ projects, targetId, onChange }: VoiceTargetPickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const target = projects.flatMap((project) => project.agents.map((agent) => ({ agent, project }))).find(({ agent }) => agent.id === targetId);

  return (
    <div className="terra-voice-target">
      {open ? (
        <div className="terra-voice-target-list terra-anim-pop" role="listbox" aria-label={t("voice.sendTo")}>
          <div className="terra-voice-target-head">
            <b>{t("voice.sendTo")}</b>
            <span>{t("voice.pickHint")}</span>
          </div>
          {projects.map((project) => (
            <div className="terra-voice-target-group" role="group" aria-label={project.name} key={project.id}>
              <span className="terra-voice-target-project">{project.name}</span>
              {project.agents.map((agent) => {
                const selected = agent.id === targetId;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    key={agent.id}
                    className="terra-voice-target-option"
                    data-selected={selected}
                    disabled={agent.status === "suspended"}
                    onClick={() => {
                      onChange(agent.id);
                      setOpen(false);
                    }}
                  >
                    <span className="terra-dot" data-status={agent.status} aria-hidden="true" />
                    <span className="terra-voice-target-copy">
                      <b>{agent.primary}</b>
                      <span data-status={agent.status}>
                        {agent.status === "exited" ? t("voice.resumesOnSend") : agent.detail}
                      </span>
                    </span>
                    <span className="terra-tag">{agent.tag}</span>
                    {selected ? <Check size={14} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
          <p className="terra-voice-target-foot">{t("voice.addressHint")}</p>
        </div>
      ) : null}
      <div className="terra-voice-target-row">
        <span>{t("voice.sendTo")}</span>
        <button
          type="button"
          className="terra-voice-target-chip"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="terra-dot" data-status={target?.agent.status ?? "working"} aria-hidden="true" />
          {target ? `${target.agent.tag} · ${target.agent.primary}` : t("voice.noTarget")}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {target?.agent.status === "exited" ? <span className="terra-voice-target-note">{t("voice.willResume")}</span> : null}
      </div>
    </div>
  );
}
