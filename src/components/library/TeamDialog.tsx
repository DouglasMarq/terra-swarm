import { useMemo, useState } from "react";
import { Users } from "lucide-react";
import { useT } from "../../i18n";
import { errorMessage } from "../../lib/errors/errorMessage";
import { planTeam, TEAM_TEMPLATES, type TeamTemplate } from "../../domain/teamTemplates";
import { useLibraryStore } from "../../stores/libraryStore";
import type { AgentInfo, AgentRole } from "../../domain/agent.model";
import { DialogFooter, TerraDialog } from "../overlays/Dialog";
import { Button } from "../ui/Button";
import "./library.css";

export interface TeamDialogProps {
  projectName: string | null;
  agents: readonly AgentInfo[];
  defaultAgent: string | null;
  canIsolate: boolean;
  onSpawn: (agent: string, options: { role: AgentRole; shouldUseWorktree: boolean }) => Promise<void>;
}

export function TeamDialog({ projectName, agents, defaultAgent, canIsolate, onSpawn }: TeamDialogProps) {
  const translate = useT();
  const isOpen = useLibraryStore((state) => state.dialog === "team");
  const closeDialog = useLibraryStore((state) => state.closeDialog);
  const [chosen, setChosen] = useState<TeamTemplate["id"]>("feature");
  const [isStarting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const template = TEAM_TEMPLATES.find((candidate) => candidate.id === chosen) ?? TEAM_TEMPLATES[0];
  const plan = useMemo(() => planTeam(template, { agents, defaultAgent, canIsolate }), [template, agents, defaultAgent, canIsolate]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      for (const member of plan.members) await onSpawn(member.agent, { role: member.role, shouldUseWorktree: member.shouldUseWorktree });
      closeDialog();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setStarting(false);
    }
  };

  return (
    <TerraDialog
      className="terra-team"
      open={isOpen}
      onOpenChange={(isNextOpen) => {
        if (!isNextOpen && !isStarting) closeDialog();
      }}
      title={translate("teams.title", { project: projectName ?? "" })}
      description={translate("teams.description")}
    >
      <div className="terra-team-list" role="radiogroup" aria-label={translate("teams.templates")}>
        {TEAM_TEMPLATES.map((candidate) => (
          <label key={candidate.id} className="terra-team-option" data-active={candidate.id === chosen}>
            <input type="radio" name="team-template" checked={candidate.id === chosen} onChange={() => setChosen(candidate.id)} />
            <span className="terra-team-name"><Users size={14} aria-hidden="true" /> {translate(`teams.${candidate.id}.name`)}</span>
            <span className="terra-team-text">{translate(`teams.${candidate.id}.description`)}</span>
          </label>
        ))}
      </div>
      {plan.isBlocked ? (
        <p className="terra-library-notice" role="alert">{translate("teams.noAgents")}</p>
      ) : (
        <ul className="terra-team-members" aria-label={translate("teams.members")}>
          {plan.members.map((member, index) => (
            <li key={`${member.role}-${index}`}>
              <strong>{translate(`roles.${member.role}`)}</strong>
              <span>{member.agent}</span>
              {member.shouldUseWorktree ? <span className="terra-team-chip">{translate("teams.worktree")}</span> : null}
              {member.isSubstituted ? <span className="terra-team-chip" data-tone="warn">{translate("teams.substituted")}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="terra-library-notice" data-tone="error" role="alert">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeDialog} disabled={isStarting}>
          {translate("common.cancel")}
        </Button>
        <Button type="button" variant="primary" onClick={() => void start()} disabled={isStarting || plan.isBlocked || !projectName}>
          {isStarting ? translate("teams.starting") : translate("teams.start", { count: plan.members.length })}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
