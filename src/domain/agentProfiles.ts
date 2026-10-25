/** Configurable agent launch/resume/voice behavior, kept independent of UI. */

import agentCatalog from "./agents.json";

export type AgentResumeCommandStrategy =
  | { kind: "original" }
  | { kind: "fixed"; command: string }
  | { kind: "append"; suffix: string; separator: string }
  | { kind: "template"; template: string };

export type AgentVoicePromptMode = "disabled" | "append" | "prepend" | "replace";

export type AgentVoicePromptBehavior = {
  enabled: boolean;
  mode: AgentVoicePromptMode;
  prefix: string;
  suffix: string;
  template?: string;
};

export type AgentProfile = {
  id: string;
  label: string;
  command: string;
  resumeCommandStrategy: AgentResumeCommandStrategy;
  voicePromptBehavior: AgentVoicePromptBehavior;
};

export type RawAgentProfile = Partial<AgentProfile> & {
  resumeCommand?: string;
  resumeStrategy?: unknown;
  voicePrompt?: unknown;
  [key: string]: unknown;
};

const DEFAULT_VOICE_BEHAVIOR: AgentVoicePromptBehavior = {
  enabled: true,
  mode: "append",
  prefix: "",
  suffix: "",
};

/** One entry of the shared agent catalog (`agents.json`). */
export interface AgentCatalogEntry {
  id: string;
  label: string;
  /** Command that continues the last session; absent when unsupported. */
  resume?: string;
  /** How Terra connects the agent to its MCP server and state hooks. */
  integration?: "claude" | "codex";
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = Object.freeze(
  (agentCatalog as { agents: AgentCatalogEntry[] }).agents,
);

export const DEFAULT_AGENT_PROFILES: readonly AgentProfile[] = Object.freeze([
  {
    id: "shell",
    label: "Shell",
    command: "",
    resumeCommandStrategy: { kind: "original" },
    voicePromptBehavior: { ...DEFAULT_VOICE_BEHAVIOR },
  },
  // Agents without a stable "continue last session" flag reopen with their
  // original command.
  ...AGENT_CATALOG.map((agent): AgentProfile => ({
    id: agent.id,
    label: agent.label,
    command: agent.id,
    resumeCommandStrategy: agent.resume ? { kind: "fixed", command: agent.resume } : { kind: "original" },
    voicePromptBehavior: { ...DEFAULT_VOICE_BEHAVIOR },
  })),
]);

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function profileId(value: unknown, fallback: string): string {
  const id = text(value);
  if (!id) return fallback;
  return id.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.:-]/g, "-");
}

function strategyFrom(raw: unknown, fallback: AgentResumeCommandStrategy): AgentResumeCommandStrategy {
  if (raw === undefined || raw === null) return { ...fallback };
  if (raw === "original" || raw === "none" || raw === "passthrough") return { kind: "original" };
  if (typeof raw === "string") {
    const command = text(raw);
    return command ? { kind: "fixed", command } : { kind: "original" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return { ...fallback };
  const value = raw as Record<string, unknown>;
  const kind = text(value.kind) ?? text(value.type) ?? text(value.mode);
  if (kind === "original" || kind === "none") return { kind: "original" };
  if (kind === "fixed" || kind === "command") {
    const command = text(value.command);
    return command ? { kind: "fixed", command } : { ...fallback };
  }
  if (kind === "append") {
    const suffix = text(value.suffix) ?? text(value.argument) ?? text(value.args);
    return suffix
      ? { kind: "append", suffix, separator: typeof value.separator === "string" ? value.separator : " " }
      : { ...fallback };
  }
  if (kind === "template") {
    const template = text(value.template);
    return template ? { kind: "template", template } : { ...fallback };
  }
  // A compact `{ command: "..." }` shape is common in hand-written config.
  const command = text(value.command);
  return command ? { kind: "fixed", command } : { ...fallback };
}

function voiceFrom(raw: unknown, fallback: AgentVoicePromptBehavior): AgentVoicePromptBehavior {
  if (raw === undefined || raw === null) return { ...fallback };
  if (raw === false || raw === "disabled" || raw === "none") {
    return { enabled: false, mode: "disabled", prefix: "", suffix: "" };
  }
  if (raw === true || raw === "append") {
    return { ...fallback, enabled: true, mode: "append" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return { ...fallback };
  const value = raw as Record<string, unknown>;
  const modeValue = text(value.mode) ?? text(value.behavior);
  const mode: AgentVoicePromptMode =
    modeValue === "prepend" || modeValue === "replace" || modeValue === "disabled"
      ? modeValue
      : modeValue === "append"
        ? "append"
        : fallback.mode;
  const template = text(value.template);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : mode !== "disabled",
    mode,
    prefix: typeof value.prefix === "string" ? value.prefix : fallback.prefix,
    suffix: typeof value.suffix === "string" ? value.suffix : fallback.suffix,
    ...(template === undefined ? {} : { template }),
  };
}

/** The built-in profile for `id`, or a plain one that runs `id` and resumes with the original command. */
export function fallbackProfile(id: string): AgentProfile {
  return (
    DEFAULT_AGENT_PROFILES.find((profile) => profile.id === id) ?? {
      id,
      label: id || "Agent",
      command: id,
      resumeCommandStrategy: { kind: "original" },
      voicePromptBehavior: { ...DEFAULT_VOICE_BEHAVIOR },
    }
  );
}

/** Normalize one profile, filling malformed or omitted fields with safe defaults. */
export function normalizeAgentProfile(
  raw: RawAgentProfile | unknown,
  fallback?: AgentProfile,
): AgentProfile {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RawAgentProfile) : {};
  const id = profileId(source.id, fallback?.id ?? "agent");
  const base = fallback ?? fallbackProfile(id);
  const command = typeof source.command === "string" ? source.command.trim() : base.command;
  const label = text(source.label) ?? base.label;
  const resumeRaw = source.resumeCommandStrategy ?? source.resumeStrategy ?? source.resumeCommand;
  const voiceRaw = source.voicePromptBehavior ?? source.voicePrompt;
  return {
    id,
    label,
    command,
    resumeCommandStrategy: strategyFrom(resumeRaw, base.resumeCommandStrategy),
    voicePromptBehavior: voiceFrom(voiceRaw, base.voicePromptBehavior),
  };
}

/** Normalize a user-configured profile list and remove duplicate IDs. */
export function normalizeAgentProfiles(
  raw: readonly RawAgentProfile[] | unknown,
  defaults: readonly AgentProfile[] = DEFAULT_AGENT_PROFILES,
): AgentProfile[] {
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.entries(raw as Record<string, unknown>).map(([id, profile]) => ({
          ...(profile && typeof profile === "object" ? profile : {}),
          id,
        }))
      : [];
  const result: AgentProfile[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeAgentProfile(entry);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    result.push(normalized);
  }
  if (result.length > 0) return result;
  return defaults.map((profile) => normalizeAgentProfile(profile, profile));
}

export function profileForCommand(
  command: string,
  profiles: readonly AgentProfile[] = DEFAULT_AGENT_PROFILES,
): AgentProfile {
  const executable = command.trim().split(/\s+/)[0] ?? "";
  return profiles.find((profile) => profile.id === executable || profile.command.split(/\s+/)[0] === executable)
    ?? fallbackProfile(executable || "shell");
}

export function resolveResumeCommand(
  profile: AgentProfile,
  originalCommand: string,
  values: Record<string, string> = {},
): string {
  const strategy = profile.resumeCommandStrategy;
  if (strategy.kind === "original") return originalCommand;
  if (strategy.kind === "fixed") return strategy.command;
  if (strategy.kind === "append") return `${originalCommand}${strategy.separator}${strategy.suffix}`.trim();
  return strategy.template
    .replace(/\{command\}/g, originalCommand)
    .replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? "");
}

/**
 * The command that starts an agent fresh. A continuation command
 * (`claude --continue`) maps back to the agent's own command, so restarting
 * an agent with no saved conversation does not fail every time.
 */
export function freshCommand(command: string): string {
  const profile = profileForCommand(command);
  const strategy = profile.resumeCommandStrategy;
  const normalized = command.trim().split(/\s+/).join(" ");
  return strategy.kind === "fixed" && normalized === strategy.command ? profile.command : command;
}

export function buildVoicePrompt(
  profile: AgentProfile,
  transcript: string,
  values: Record<string, string> = {},
): string {
  const behavior = profile.voicePromptBehavior;
  if (!behavior.enabled || behavior.mode === "disabled") return transcript;
  const rendered = behavior.template
      ? behavior.template
        .replace(/\{text\}/g, transcript)
        .replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? "")
    : transcript;
  if (behavior.mode === "replace") {
    return behavior.template ? rendered : `${behavior.prefix}${rendered}${behavior.suffix}`;
  }
  if (behavior.mode === "prepend") return `${behavior.prefix}${rendered}${behavior.suffix}`;
  return `${rendered}${behavior.suffix}`;
}
