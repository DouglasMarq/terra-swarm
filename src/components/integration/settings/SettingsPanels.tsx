import { onVoiceAudioLevel } from "../../../lib/tauri/voice";
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import type { AgentInfo } from "../../../domain/agent.model";
import type { VoiceModelInfo } from "../../../domain/voice.model";
import {
  DEFAULT_AGENT_PROFILES,
  fallbackProfile,
  type AgentProfile,
} from "../../../domain/agentProfiles";
import {
  type FeatureFlagId,
  type FeatureFlags,
} from "../../../lib/features/featureFlags";
import {
  GRID_COL_OPTIONS,
  HOTKEY_ACTIONS,
  hotkeyActionLabel,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  DEFAULT_HOTKEYS,
  formatHotkey,
  type Hotkey,
  type HotkeyActionId,
} from "../../../stores/preferencesStore";
import { parseEnvLines } from "../../../domain/agentLaunchEnv";
import type {
  SettingsSectionDefinition,
  SettingsSectionId,
} from "../../settings";
import { LOCALES, useLocaleStore, useT, type Locale } from "../../../i18n";
import { pickAgentName, type NameSetId } from "../../../domain/agentNames";
import { isVoiceLanguage, VOICE_LANGUAGE_ENDONYMS, VOICE_LANGUAGES, type VoiceLanguage } from "../../../domain/voiceLanguages";
import { useMcpStore } from "../../../stores/mcpStore";
import { usePreferencesStore } from "../../../stores/preferencesStore";
import { DEFAULT_TERMINAL_FONT_STACK, filterFonts, terminalFontStack, type SystemFont } from "../../../lib/terminalFonts";
import { loadSystemFonts } from "../../../app/systemFonts";
import type { SnapshotFeedback, SnapshotOperation } from "../../../app/useSnapshotTransfer";
import styles from "./SettingsPanels.module.css";

export type UpdateCheckState = "idle" | "checking" | "uptodate" | "error";

export interface VoiceDownloadState {
  id: string;
  percent: number;
}

export interface SettingsPanelsProps {
  section: SettingsSectionDefinition;
  agents: readonly AgentInfo[];
  defaultAgent: string | null;
  onDefaultAgentChange: (agent: string | null) => void;
  availableShells: readonly string[];
  defaultShell: string;
  onDefaultShellChange: (shell: string) => void;
  fontSize: number;
  onFontSizeChange: (delta: number) => void;
  onFontSizeReset: () => void;
  gridCols: number;
  onGridLayoutChange: (columns: number) => void | Promise<void>;
  reduceMotion: boolean;
  onReduceMotionChange: (enabled: boolean) => void;
  flags: FeatureFlags;
  onFeatureFlagChange: (id: FeatureFlagId, enabled: boolean) => void;
  voiceEnabled: boolean;
  onVoiceEnabledChange: (enabled: boolean) => void;
  voiceLang: VoiceLanguage;
  onVoiceLangChange: (lang: VoiceLanguage) => void;
  voiceInputDevice: string | null;
  voiceInputDevices: readonly string[];
  onVoiceInputDeviceChange: (device: string) => void;
  micAvailable: boolean | null;
  micTesting: boolean;
  onMicTestToggle: () => void;
  voiceModels: readonly VoiceModelInfo[];
  /** "error" when the model list could not be read; "loading" until it is. */
  voiceModelsStatus?: "loading" | "ready" | "error";
  onRetryVoiceModels?: () => void;
  voiceDownload: VoiceDownloadState | null;
  onVoiceModelSelect: (id: string) => void;
  onVoiceModelDownload: (id: string) => void;
  hotkeys: Readonly<Record<HotkeyActionId, Hotkey>>;
  capturing: HotkeyActionId | null;
  onCaptureHotkey: (id: HotkeyActionId) => void;
  onResetHotkeys: () => void;
  snapshotOperation: SnapshotOperation | null;
  snapshotFeedback: SnapshotFeedback | null;
  onExportSnapshot: () => void;
  onImportSnapshot: () => void;
  appVersion: string;
  updateVersion: string | null;
  updateInstalling: boolean;
  updateCheckState: UpdateCheckState;
  onManualUpdateCheck: () => void;
  onInstallUpdate: () => void;
}


// Groups, sub-tabs and the Fleet are product foundations; only these remain optional.
const LAB_FEATURE_FLAG_IDS = ["durableScrollback", "voiceCommands"] as const;

const PROFILE_BY_ID = new Map(DEFAULT_AGENT_PROFILES.map((profile) => [profile.id, profile]));

/** Speech levels are low; the meter scales them up so normal speech fills it. */
const MIC_LEVEL_GAIN = 10;

function PanelLead({ section }: { section: SettingsSectionDefinition }) {
  useT();
  return (
    <div className={styles.lead}>
      <h3 className={styles.title}>{section.label}</h3>
      <p className={styles.description}>{section.description}</p>
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`${styles.toggle} ${checked ? styles.toggleOn : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.toggleKnob} />
    </button>
  );
}

function MicLevelMeter({ active }: { active: boolean }) {
  const translate = useT();
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return undefined;
    const unlisten = onVoiceAudioLevel((level) => {
      const element = fillRef.current;
      if (!element) return;
      element.style.transform = `scaleX(${Math.min(1, level * MIC_LEVEL_GAIN)})`;
    });
    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, [active]);

  return (
    <div className={styles.micMeter} aria-label={translate("settingsPanels.micLevel")}>
      <div className={styles.micMeterFill} ref={fillRef} />
    </div>
  );
}

function LanguageCard() {
  const translate = useT();
  const locale = useLocaleStore((state) => state.locale);
  const setLocale = useLocaleStore((state) => state.setLocale);
  return (
    <div className={styles.card}>
      <span className={styles.cardTitle}>{translate("settings.language.title")}</span>
      <label className={styles.fieldLabel}>
        {translate("settings.language.label")}
        <select className={styles.select} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
          {LOCALES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <p className={styles.hint}>{translate("settings.language.hint")}</p>
    </div>
  );
}

interface FontOptionRow {
  name: string;
  label: string;
  isMonospace: boolean;
  note?: string;
}

/** Font family picker: every installed family, a search box and a
 * monospace-only filter; each row renders in its own font. */
function TerminalFontPicker({ fontSize }: { fontSize: number }) {
  const translate = useT();
  const family = usePreferencesStore((state) => state.terminalFontFamily);
  const setFamily = usePreferencesStore((state) => state.setTerminalFontFamily);
  const [fonts, setFonts] = useState<SystemFont[] | null>(null);
  const [query, setQuery] = useState("");
  const [monospaceOnly, setMonospaceOnly] = useState(false);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    void loadSystemFonts().then((list) => {
      if (alive) setFonts(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (fonts) selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [fonts]);

  const shown = useMemo(() => filterFonts(fonts ?? [], query, monospaceOnly), [fonts, query, monospaceOnly]);
  const missing = fonts !== null && family !== "" && !fonts.some((font) => font.name === family);
  const monoCount = fonts?.filter((font) => font.monospace).length ?? 0;

  const row = ({ name, label, isMonospace, note }: FontOptionRow) => {
    const selected = family === name;
    return (
      <button
        key={name || "__default"}
        ref={selected ? selectedRef : undefined}
        type="button"
        role="option"
        aria-selected={selected}
        className={styles.fontOption}
        data-selected={selected}
        onClick={() => setFamily(name)}
      >
        <span className={styles.fontOptionName} style={{ fontFamily: name ? terminalFontStack(name) : DEFAULT_TERMINAL_FONT_STACK }}>{label}</span>
        {note ? <span className={styles.fontOptionTag}>{note}</span> : isMonospace ? <span className={styles.fontOptionTag}>{translate("settingsPanels.fontMono")}</span> : null}
      </button>
    );
  };

  return (
    <div className={styles.fontPicker}>
      <div className={styles.rowLabel}>
        <span className={styles.label}>{translate("settingsPanels.fontFamily")}</span>
        <span className={styles.rowHint}>
          {fonts === null
            ? translate("settingsPanels.fontLoading")
            : translate("settingsPanels.fontFamilyHint", { count: fonts.length, mono: monoCount })}
        </span>
      </div>
      <div className={styles.fontFilters}>
        <input
          className={styles.textInput}
          type="search"
          aria-label={translate("settingsPanels.fontSearch")}
          placeholder={translate("settingsPanels.fontSearch")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className={styles.chip}
          aria-pressed={monospaceOnly}
          data-active={monospaceOnly}
          onClick={() => setMonospaceOnly((value) => !value)}
        >
          {translate("settingsPanels.fontMonoOnly")}
        </button>
      </div>
      <div className={styles.fontList} role="listbox" aria-label={translate("settingsPanels.fontFamily")}>
        {!query ? row({ name: "", label: translate("settingsPanels.fontDefault"), isMonospace: true }) : null}
        {missing ? row({ name: family, label: family, isMonospace: false, note: translate("settingsPanels.fontMissing") }) : null}
        {shown.map((font) => row({ name: font.name, label: font.name, isMonospace: font.monospace }))}
        {fonts !== null && shown.length === 0 ? <div className={styles.fontEmpty}>{translate("settingsPanels.fontNoMatch")}</div> : null}
      </div>
      <div
        className={styles.fontPreview}
        aria-hidden="true"
        style={{ fontFamily: family ? terminalFontStack(family) : DEFAULT_TERMINAL_FONT_STACK, fontSize }}
      >
        <span>$ claude --continue</span>
        <span>0O 1lI {"{} [] => != <= ~"}</span>
      </div>
    </div>
  );
}

/** Names currently held by open agents, for "in use" and the next pick. */
function useNamesInUse(): string[] {
  const agentNames = usePreferencesStore((state) => state.agentNames);
  return useMemo(() => Object.values(agentNames), [agentNames]);
}

/** Dictation goes to the project's orchestrator agent when one is running. */
function VoiceToOrchestratorRow() {
  const translate = useT();
  const enabled = usePreferencesStore((state) => state.voiceToOrchestrator);
  const setEnabled = usePreferencesStore((state) => state.setVoiceToOrchestrator);
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>
        <span className={styles.label}>{translate("settingsPanels.voiceToOrchestrator")}</span>
        <span className={styles.rowHint}>{translate("settingsPanels.voiceToOrchestratorHint")}</span>
      </div>
      <Toggle checked={enabled} label={translate("settingsPanels.voiceToOrchestrator")} onChange={setEnabled} />
    </div>
  );
}

/** Native notifications and the app icon badge. */
function SystemNotificationsCard() {
  const translate = useT();
  const enabled = usePreferencesStore((state) => state.systemNotifications);
  const setEnabled = usePreferencesStore((state) => state.setSystemNotifications);
  return (
    <div className={styles.card}>
      <span className={styles.cardTitle}>{translate("settingsPanels.notificationsTitle")}</span>
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <span className={styles.label}>{translate("settingsPanels.systemNotifications")}</span>
          <span className={styles.rowHint}>{translate("settingsPanels.systemNotificationsHint")}</span>
        </div>
        <Toggle checked={enabled} label={translate("settingsPanels.systemNotifications")} onChange={setEnabled} />
      </div>
    </div>
  );
}

/** Extra arguments and environment variables used every time an agent starts. */
function AgentLaunchEditor({ agentId, label }: { agentId: string; label: string }) {
  const translate = useT();
  const saved = usePreferencesStore((state) => state.agentLaunch[agentId]);
  const setAgentLaunch = usePreferencesStore((state) => state.setAgentLaunch);
  const [open, setOpen] = useState(false);
  const [args, setArgs] = useState(saved?.args ?? "");
  const [env, setEnv] = useState(saved?.env ?? "");
  const invalid = parseEnvLines(env).invalid;
  const configured = Boolean(saved?.args.trim() || saved?.env.trim());
  const save = () => setAgentLaunch(agentId, { args, env });
  return (
    <div className={styles.agentLaunch}>
      <button
        type="button"
        className={styles.agentLaunchToggle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {translate("settingsPanels.launchOptions")}
        {configured ? <span className={styles.agentLaunchBadge}>{translate("settingsPanels.launchConfigured")}</span> : null}
      </button>
      {open ? (
        <div className={styles.stack}>
          <label className={styles.fieldLabel}>
            {translate("settingsPanels.launchArgs")}
            <input
              className={styles.input}
              value={args}
              placeholder={translate("settingsPanels.launchArgsPlaceholder")}
              aria-label={translate("settingsPanels.launchArgsFor", { name: label })}
              onChange={(event) => setArgs(event.target.value)}
              onBlur={save}
            />
          </label>
          <label className={styles.fieldLabel}>
            {translate("settingsPanels.launchEnv")}
            <textarea
              className={styles.textarea}
              value={env}
              rows={3}
              spellCheck={false}
              placeholder="ANTHROPIC_MODEL=claude-sonnet-5-5"
              aria-label={translate("settingsPanels.launchEnvFor", { name: label })}
              onChange={(event) => setEnv(event.target.value)}
              onBlur={save}
            />
          </label>
          {invalid.length > 0 ? (
            <p className={styles.hint} role="alert">{translate("settingsPanels.launchEnvInvalid", { lines: invalid.join(", ") })}</p>
          ) : (
            <p className={styles.hint}>{translate("settingsPanels.launchHint")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The embedded MCP server: the on/off switch and where it listens. */
function McpCard() {
  const translate = useT();
  const server = useMcpStore((state) => state.server);
  const loadServer = useMcpStore((state) => state.loadServer);
  const setEnabled = useMcpStore((state) => state.setEnabled);
  useEffect(() => {
    void loadServer();
  }, [loadServer]);
  return (
    <div className={styles.card}>
      <span className={styles.cardTitle}>{translate("settingsPanels.mcpTitle")}</span>
      <p className={styles.cardDescription}>{translate("settingsPanels.mcpHint")}</p>
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <span className={styles.label}>{translate("settingsPanels.mcpExpose")}</span>
          <span className={styles.rowHint}>{translate("settingsPanels.mcpExposeHint")}</span>
        </div>
        <Toggle
          checked={server ? server.available && server.enabled : true}
          disabled={!server || !server.available}
          label={translate("settingsPanels.mcpExpose")}
          onChange={(enabled) => void setEnabled(enabled)}
        />
      </div>
      {server && !server.available ? (
        <p className={styles.hint} role="alert">
          {translate("settingsPanels.mcpUnavailable", { error: server.error ?? "" })}
        </p>
      ) : server ? (
        server.running && server.url ? (
          <p className={styles.hint}>
            {server.port ? translate("settingsPanels.mcpUrlWithPort", { url: server.url, port: server.port }) : translate("settingsPanels.mcpUrl", { url: server.url })}
          </p>
        ) : (
          <p className={styles.hint}>{translate("settingsPanels.mcpNotRunning")}</p>
        )
      ) : null}
      {server?.db_path ? (
        <p className={styles.hint}>
          {translate("settingsPanels.mcpDbPath")}: <code className={styles.agentCommand}>{server.db_path}</code>
        </p>
      ) : null}
    </div>
  );
}

function AgentNamesCard() {
  const translate = useT();
  const prefs = usePreferencesStore();
  const inUse = useNamesInUse();
  const [draft, setDraft] = useState("");
  const next = pickAgentName(inUse, prefs.agentNameList, { avoidSimilar: prefs.avoidSimilarNames, exhausted: prefs.namesExhausted });
  const usedCount = prefs.agentNameList.filter((name) => inUse.includes(name)).length;

  const addName = () => {
    if (!draft.trim()) return;
    prefs.setAgentNameList([...prefs.agentNameList, draft.trim()]);
    setDraft("");
  };

  return (
    <div className={styles.card}>
      <span className={styles.cardTitle}>{translate("settingsPanels.namesTitle")}</span>
      <p className={styles.cardDescription}>{translate("settingsPanels.namesHint")}</p>
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <span className={styles.label}>{translate("settingsPanels.autoNames")}</span>
          <span className={styles.rowHint}>{translate("settingsPanels.autoNamesHint")}</span>
        </div>
        <Toggle checked={prefs.agentAutoNames} label={translate("settingsPanels.autoNames")} onChange={prefs.setAgentAutoNames} />
      </div>
      {prefs.agentAutoNames ? (
        <div className={styles.stack}>
          <label className={styles.fieldLabel}>
            {translate("settingsPanels.nameSet")}
            <select className={styles.select} value={prefs.agentNameSet} onChange={(event) => prefs.setAgentNameSet(event.target.value as NameSetId)}>
              <option value="stars">{translate("settingsPanels.sets.stars")}</option>
              <option value="rivers">{translate("settingsPanels.sets.rivers")}</option>
              <option value="custom">{translate("settingsPanels.sets.custom")}</option>
            </select>
          </label>
          <div className={styles.nameChips}>
            {prefs.agentNameList.map((name) => {
              const used = inUse.includes(name);
              return (
                <span className={styles.nameChip} data-used={used} key={name} title={name}>
                  <span className={styles.nameChipDot} aria-hidden="true" />
                  {name}
                  <button
                    type="button"
                    className={styles.nameChipRemove}
                    aria-label={translate("settingsPanels.remove", { name })}
                    onClick={() => prefs.setAgentNameList(prefs.agentNameList.filter((candidate) => candidate !== name))}
                  >
                    <X size={10} aria-hidden="true" />
                  </button>
                </span>
              );
            })}
          </div>
          <div className={styles.nameAdd}>
            <input
              className={styles.input}
              aria-label={translate("settingsPanels.addName")}
              placeholder={translate("settingsPanels.addName")}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addName();
              }}
            />
            <button type="button" className={styles.button} onClick={addName}>{translate("settingsPanels.add")}</button>
          </div>
          <p className={styles.hint}>
            {translate("settingsPanels.namesUsage", { inUse: usedCount, free: prefs.agentNameList.length - usedCount, next: next ?? "—" })}
          </p>
          <div className={styles.row}>
            <div className={styles.rowLabel}>
              <span className={styles.label}>{translate("settingsPanels.avoidSimilar")}</span>
              <span className={styles.rowHint}>{translate("settingsPanels.avoidSimilarHint")}</span>
            </div>
            <Toggle checked={prefs.avoidSimilarNames} label={translate("settingsPanels.avoidSimilar")} onChange={prefs.setAvoidSimilarNames} />
          </div>
          <label className={styles.fieldLabel}>
            {translate("settingsPanels.exhausted")}
            <select className={styles.select} value={prefs.namesExhausted} onChange={(event) => prefs.setNamesExhausted(event.target.value === "repeat" ? "repeat" : "type-number")}>
              <option value="type-number">{translate("settingsPanels.exhaustedType")}</option>
              <option value="repeat">{translate("settingsPanels.exhaustedRepeat")}</option>
            </select>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function AgentPanel({
  agents,
  defaultAgent,
  onDefaultAgentChange,
}: Pick<SettingsPanelsProps, "agents" | "defaultAgent" | "onDefaultAgentChange">) {
  const translate = useT();
  const newAgentHotkey = usePreferencesStore((state) => state.hotkeys.newTerminal ?? DEFAULT_HOTKEYS.newTerminal);
  const profiles: AgentProfile[] = agents.map((agent) =>
    PROFILE_BY_ID.get(agent.id) ?? { ...fallbackProfile(agent.id), label: agent.label },
  );
  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <span className={styles.cardTitle}>{translate("settingsPanels.defaultAgentTitle")}</span>
        <p className={styles.cardDescription}>{translate("settingsPanels.defaultAgentHint", { shortcut: formatHotkey(newAgentHotkey) })}</p>
        <label className={styles.fieldLabel}>
          {translate("settingsPanels.defaultAgentLabel")}
          <select
            className={styles.select}
            value={defaultAgent ?? ""}
            onChange={(event) => onDefaultAgentChange(event.target.value || null)}
          >
            <option value="">{translate("settingsPanels.askEachTime")}</option>
            {agents.filter((agent) => agent.available).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label} ({agent.id})
              </option>
            ))}
          </select>
        </label>
      </div>
      <McpCard />
      <div className={styles.card}>
        <span className={styles.cardTitle}>{translate("settingsPanels.detectedTitle")}</span>
        <p className={styles.cardDescription}>{translate("settingsPanels.detectedHint")}</p>
        {profiles.length === 0 ? (
          <div className={styles.empty}>{translate("settingsPanels.detectedNone")}</div>
        ) : (
          <div className={styles.agentList}>
            {profiles.map((profile) => {
              const detected = agents.find((agent) => agent.id === profile.id);
              const available = detected?.available ?? true;
              return (
                <div className={styles.agentEntry} key={profile.id}>
                  <div className={styles.agentRow}>
                    <div className={styles.agentIdentity}>
                      <span className={styles.agentName}>{profile.label}</span>
                      <span className={styles.agentCommand}>{profile.command || "shell"}</span>
                    </div>
                    <span className={`${styles.status} ${available ? styles.available : styles.unavailable}`}>
                      {available ? translate("settingsPanels.available") : translate("settingsPanels.notFound")}
                    </span>
                  </div>
                  {profile.id !== "shell" && available ? <AgentLaunchEditor agentId={profile.id} label={profile.label} /> : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <AgentNamesCard />
    </div>
  );
}

export function SettingsSectionPanel({ section, ...props }: SettingsPanelsProps) {
  const translate = useT();
  const {
    agents,
    defaultAgent,
    onDefaultAgentChange,
    availableShells,
    defaultShell,
    onDefaultShellChange,
    fontSize,
    onFontSizeChange,
    onFontSizeReset,
    gridCols,
    onGridLayoutChange,
    reduceMotion,
    onReduceMotionChange,
    flags,
    onFeatureFlagChange,
    voiceEnabled,
    onVoiceEnabledChange,
    voiceLang,
    onVoiceLangChange,
    voiceInputDevice,
    voiceInputDevices,
    onVoiceInputDeviceChange,
    micAvailable,
    micTesting,
    onMicTestToggle,
    voiceModels,
    voiceModelsStatus = "ready",
    onRetryVoiceModels,
    voiceDownload,
    onVoiceModelSelect,
    onVoiceModelDownload,
    hotkeys,
    capturing,
    onCaptureHotkey,
    onResetHotkeys,
    snapshotOperation,
    snapshotFeedback,
    onExportSnapshot,
    onImportSnapshot,
    appVersion,
    updateVersion,
    updateInstalling,
    updateCheckState,
    onManualUpdateCheck,
    onInstallUpdate,
  } = props;

  return (
    <div className={styles.panel}>
      <PanelLead section={section} />

      {section.id === "general" && (
        <div className={styles.stack}>
          <LanguageCard />
          <SystemNotificationsCard />
          <div className={styles.card}>
            <span className={styles.cardTitle}>{translate("settingsPanels.accessibility")}</span>
            <p className={styles.cardDescription}>{translate("settingsPanels.accessibilityHint")}</p>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>{translate("settingsPanels.reduceMotion")}</span>
                <span className={styles.rowHint}>{translate("settingsPanels.reduceMotionHint")}</span>
              </div>
              <Toggle checked={reduceMotion} label={translate("settingsPanels.reduceMotion")} onChange={onReduceMotionChange} />
            </div>
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{translate("settingsPanels.labs")}</span>
            <p className={styles.cardDescription}>{translate("settingsPanels.labsHint")}</p>
            <div className={styles.stack}>
              {LAB_FEATURE_FLAG_IDS.map((id) => (
                <div className={styles.row} key={id}>
                  <div className={styles.rowLabel}>
                    <span className={styles.label}>{translate(`settingsPanels.flags.${id}.label`)}</span>
                    <span className={styles.rowHint}>{translate(`settingsPanels.flags.${id}.description`)}</span>
                  </div>
                  <Toggle checked={flags[id]} label={translate(`settingsPanels.flags.${id}.label`)} onChange={(enabled) => onFeatureFlagChange(id, enabled)} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {section.id === "terminal" && (
        <div className={styles.stack}>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{translate("settingsPanels.fontTitle")}</span>
            <TerminalFontPicker fontSize={fontSize} />
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>{translate("settingsPanels.fontSize")}</span>
                <span className={styles.rowHint}>{translate("settingsPanels.fontRange", { size: fontSize, min: MIN_FONT_SIZE, max: MAX_FONT_SIZE })}</span>
              </div>
              <div className={styles.stepper}>
                <button className={styles.stepperButton} disabled={fontSize <= MIN_FONT_SIZE} onClick={() => onFontSizeChange(-1)} aria-label={translate("settingsPanels.fontDecrease")}>−</button>
                <span className={styles.stepperValue}>{fontSize}px</span>
                <button className={styles.stepperButton} disabled={fontSize >= MAX_FONT_SIZE} onClick={() => onFontSizeChange(1)} aria-label={translate("settingsPanels.fontIncrease")}>+</button>
                <button className={styles.chip} onClick={onFontSizeReset}>{translate("settingsPanels.reset")}</button>
              </div>
            </div>
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{translate("settingsPanels.layoutTitle")}</span>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>{translate("settingsPanels.sideBySide")}</span>
                <span className={styles.rowHint}>{translate("settingsPanels.sideBySideHint")}</span>
              </div>
              <div className={styles.gridOptions} aria-label={translate("settingsPanels.gridColumns")}>
                {GRID_COL_OPTIONS.map((columns) => (
                  <button
                    key={columns}
                    className={`${styles.gridOption} ${gridCols === columns ? styles.gridOptionActive : ""}`}
                    aria-pressed={gridCols === columns}
                    onClick={() => void onGridLayoutChange(columns)}
                  >
                    {columns}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{translate("settingsPanels.shellTitle")}</span>
            <label className={styles.fieldLabel}>
              {translate("settingsPanels.shellLabel")}
              <select className={styles.select} value={defaultShell} onChange={(event) => onDefaultShellChange(event.target.value)}>
                <option value="">{translate("settingsPanels.systemDefault")}</option>
                {(defaultShell && !availableShells.includes(defaultShell) ? [defaultShell, ...availableShells] : availableShells).map((shell) => (
                  <option key={shell} value={shell}>{shell}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}

      {section.id === "voice" && (
        <div className={styles.stack}>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{translate("settingsPanels.voiceTitle")}</span>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>{translate("settingsPanels.voiceEnable")}</span>
                <span className={styles.rowHint}>{translate("settingsPanels.voiceEnableHint")}</span>
              </div>
              <Toggle checked={voiceEnabled} label={translate("settingsPanels.voiceEnableLabel")} disabled={micAvailable === false && !voiceEnabled} onChange={onVoiceEnabledChange} />
            </div>
            {micAvailable === false && !voiceEnabled ? <p className={styles.hint}>{translate("settingsPanels.noMic")}</p> : null}
            {voiceEnabled ? (
              <>
                <label className={styles.fieldLabel}>
                  {translate("settingsPanels.voiceLanguage")}
                  <select className={styles.select} value={voiceLang} onChange={(event) => { if (isVoiceLanguage(event.target.value)) onVoiceLangChange(event.target.value); }}>
                    {VOICE_LANGUAGES.map((code) => <option key={code} value={code}>{code === "auto" ? translate("settingsPanels.voiceLanguageAuto") : VOICE_LANGUAGE_ENDONYMS[code]}</option>)}
                  </select>
                </label>
                <label className={styles.fieldLabel}>
                  {translate("settingsPanels.inputDevice")}
                  <select className={styles.select} value={voiceInputDevice ?? ""} title={voiceInputDevice ?? translate("settingsPanels.systemDefault")} onChange={(event) => onVoiceInputDeviceChange(event.target.value)}>
                    <option value="">{translate("settingsPanels.systemDefault")}</option>
                    {voiceInputDevice && !voiceInputDevices.includes(voiceInputDevice) ? <option value={voiceInputDevice}>{translate("settingsPanels.disconnected", { name: voiceInputDevice })}</option> : null}
                    {voiceInputDevices.map((device) => <option key={device} value={device}>{device}</option>)}
                  </select>
                </label>
                <div className={styles.row}>
                  <div className={styles.rowLabel}>
                    <span className={styles.label}>{translate("settingsPanels.micTest")}</span>
                    <span className={styles.rowHint}>{translate("settingsPanels.micTestHint")}</span>
                  </div>
                  <div className={styles.micTest}>
                    <MicLevelMeter active={micTesting} />
                    <button className={styles.chip} onClick={onMicTestToggle}>{micTesting ? translate("settingsPanels.stop") : translate("settingsPanels.test")}</button>
                  </div>
                </div>
                {micTesting ? <p className={styles.hint}>{translate("settingsPanels.micTestBody")}</p> : null}
                <VoiceToOrchestratorRow />
              </>
            ) : null}
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{translate("settingsPanels.modelsTitle")}</span>
            <p className={styles.cardDescription}>{translate("settingsPanels.modelsHint")}</p>
            {voiceModels.length === 0 && voiceModelsStatus === "loading" ? <div className={styles.empty}>{translate("settingsPanels.modelsLoading")}</div> : null}
            {voiceModels.length === 0 && voiceModelsStatus !== "loading" ? (
              <div className={styles.empty} role="alert">
                <span>{translate("settingsPanels.modelsFailed")}</span>
                {onRetryVoiceModels ? <button className={styles.chip} onClick={onRetryVoiceModels}>{translate("nav.retry")}</button> : null}
              </div>
            ) : null}
            {voiceModels.length > 0 && !voiceModels.some((model) => model.downloaded) ? <p className={styles.hint}>{translate("settingsPanels.modelsNone")}</p> : null}
            <div className={styles.modelList}>
              {voiceModels.map((model) => (
                <div className={styles.modelRow} key={model.id}>
                  <div className={styles.modelIdentity}>
                    <span className={styles.modelName} title={model.description}>{model.display_name}</span>
                    <span className={styles.modelMeta}>{model.size_label}</span>
                  </div>
                  {voiceDownload?.id === model.id ? <span className={styles.status}>{Math.floor(voiceDownload.percent)}%</span> : model.active ? <span className={`${styles.chip} ${styles.chipActive}`}>{translate("settingsPanels.active")}</span> : model.downloaded ? <button className={styles.chip} onClick={() => onVoiceModelSelect(model.id)}>{translate("settingsPanels.use")}</button> : <button className={styles.chip} disabled={voiceDownload !== null} onClick={() => onVoiceModelDownload(model.id)}>{translate("settingsPanels.download")}</button>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {section.id === "agents" && <AgentPanel agents={agents} defaultAgent={defaultAgent} onDefaultAgentChange={onDefaultAgentChange} />}

      {section.id === "shortcuts" && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>{translate("settingsPanels.shortcutsTitle")}</span>
          <p className={styles.cardDescription}>{translate("settingsPanels.shortcutsHint")}</p>
          <div className={styles.shortcutList}>
            {HOTKEY_ACTIONS.map((action) => (
              <div className={styles.shortcutRow} key={action.id}>
                <span className={styles.shortcutIdentity}><span className={styles.shortcutName}>{hotkeyActionLabel(action.id)}</span></span>
                {capturing === action.id ? <span className={styles.status}>{translate("settingsPanels.pressShortcut")}</span> : <button className={styles.chip} onClick={() => onCaptureHotkey(action.id)}>{formatHotkey(hotkeys[action.id])}</button>}
              </div>
            ))}
          </div>
          <div className={styles.actions}><button className={styles.button} onClick={onResetHotkeys}>{translate("settingsPanels.restoreDefaults")}</button></div>
        </div>
      )}

      {section.id === "data" && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>{translate("settingsPanels.dataTitle")}</span>
          <p className={styles.cardDescription}>{translate("settingsPanels.dataHint")}</p>
          <div className={styles.actions}>
            <button className={styles.primary} disabled={snapshotOperation !== null} onClick={onExportSnapshot}>{snapshotOperation === "exporting" ? translate("settingsPanels.exporting") : translate("settingsPanels.exportSnapshot")}</button>
            <button className={styles.button} disabled={snapshotOperation !== null} onClick={onImportSnapshot}>{snapshotOperation === "importing" ? translate("settingsPanels.importing") : translate("settingsPanels.importSnapshot")}</button>
          </div>
          <p className={styles.hint}>{translate("settingsPanels.importHint")}</p>
          {snapshotFeedback ? <div className={`${styles.feedback} ${snapshotFeedback.kind === "error" ? styles.feedbackError : styles.feedbackSuccess}`} role={snapshotFeedback.kind === "error" ? "alert" : "status"} aria-live="polite"><span>{snapshotFeedback.message}</span>{snapshotFeedback.backupPath ? <span className={styles.path}>{translate(snapshotFeedback.pathKind === "backup" ? "settingsPanels.backupPath" : "settingsPanels.filePath", { path: snapshotFeedback.backupPath })}</span> : null}</div> : null}
        </div>
      )}

      {section.id === "about" && (
        <div className={styles.stack}>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{translate("common.appName")}</span>
            <div className={styles.row}><span className={styles.label}>{translate("settingsPanels.installedVersion")}</span><span className={styles.status}>{appVersion || translate("settingsPanels.unknown")}</span></div>
            <p className={styles.hint}>{translate("settingsPanels.localHint")}</p>
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{translate("settingsPanels.updatesTitle")}</span>
            {updateVersion ? <div className={styles.row}><span className={styles.label}>{translate("settingsPanels.updateAvailable", { version: updateVersion })}</span><button className={styles.primary} disabled={updateInstalling} onClick={onInstallUpdate}>{updateInstalling ? translate("settingsPanels.installing") : translate("settingsPanels.updateNow")}</button></div> : <div className={styles.row}><span className={styles.status}>{updateCheckState === "checking" ? translate("settingsPanels.checking") : updateCheckState === "uptodate" ? translate("settingsPanels.upToDate") : updateCheckState === "error" ? translate("settingsPanels.checkFailed") : translate("settingsPanels.checkHourly")}</span><button className={styles.chip} disabled={updateCheckState === "checking"} onClick={onManualUpdateCheck}>{translate("settingsPanels.checkNow")}</button></div>}
          </div>
        </div>
      )}
    </div>
  );
}

export type { SettingsSectionId };
