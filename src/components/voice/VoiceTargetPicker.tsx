import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useT } from "../../i18n";
import { agentLabelText } from "../../domain/agentLabels";

export type VoiceTargetStatus = "working" | "idle" | "attention" | "exited" | "suspended";

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
  const translate = useT();
  const [isOpen, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Close the list only; the capsule stays open.
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isOpen]);
  const target = projects.flatMap((project) => project.agents.map((agent) => ({ agent, project }))).find(({ agent }) => agent.id === targetId);

  return (
    <div className="terra-voice-target" ref={rootRef}>
      {isOpen ? (
        <div className="terra-voice-target-list terra-anim-pop" role="listbox" aria-label={translate("voice.sendTo")}>
          <div className="terra-voice-target-head">
            <b>{translate("voice.sendTo")}</b>
            <span>{translate("voice.pickHint")}</span>
          </div>
          {projects.map((project) => (
            <div className="terra-voice-target-group" role="group" aria-label={project.name} key={project.id}>
              <span className="terra-voice-target-project">{project.name}</span>
              {project.agents.map((agent) => {
                const isSelected = agent.id === targetId;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    key={agent.id}
                    className="terra-voice-target-option"
                    data-selected={isSelected}
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
                        {agent.status === "exited" ? translate("voice.resumesOnSend") : agent.detail}
                      </span>
                    </span>
                    <span className="terra-tag">{agent.tag}</span>
                    {isSelected ? <Check size={14} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
          <p className="terra-voice-target-foot">{translate("voice.addressHint")}</p>
        </div>
      ) : null}
      <div className="terra-voice-target-row">
        <span>{translate("voice.sendTo")}</span>
        <button
          type="button"
          className="terra-voice-target-chip"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onClick={() => setOpen((isCurrentlyOpen) => !isCurrentlyOpen)}
        >
          <span className="terra-dot" data-status={target?.agent.status ?? "working"} aria-hidden="true" />
          {target ? agentLabelText(target.agent) : translate("voice.noTarget")}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {target?.agent.status === "exited" ? <span className="terra-voice-target-note">{translate("voice.willResume")}</span> : null}
      </div>
    </div>
  );
}
