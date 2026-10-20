import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import type {
  AgentInfo,
  VoiceModelInfo,
} from "../../../types";
import {
  DEFAULT_AGENT_PROFILES,
  type AgentProfile,
} from "../../../lib/features/agentProfiles";
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
  formatHotkey,
  type Hotkey,
} from "../../../stores/preferencesStore";
import type {
  SettingsSectionDefinition,
  SettingsSectionId,
} from "../../settings";
import { LOCALES, useLocaleStore, useT, type Locale } from "../../../i18n";
import { pickAgentName, type NameSetId } from "../../../domain/agentNames";
import { useMcpStore } from "../../../stores/mcpStore";
import { usePreferencesStore } from "../../../stores/preferencesStore";
import { DEFAULT_TERMINAL_FONT_STACK, filterFonts, loadSystemFonts, terminalFontStack, type SystemFont } from "../../../lib/terminalFonts";
import styles from "./SettingsPanels.module.css";

export type SnapshotOperation = "exporting" | "importing";

export interface SnapshotFeedback {
  kind: "success" | "error";
  message: string;
  backupPath?: string | null;
  /** "backup" after an import (the pre-import copy), "file" after an export. */
  pathKind?: "backup" | "file";
}

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
  voiceLang: string;
  onVoiceLangChange: (lang: string) => void;
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
  hotkeys: Readonly<Record<string, Hotkey>>;
  capturing: string | null;
  onCaptureHotkey: (id: string) => void;
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


/** Voice languages are listed by their own name, so they read the same in any UI locale. */
const VOICE_LANGUAGES = [
  ["auto", "Auto"],
  ["pt", "Português"],
  ["en", "English"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["it", "Italiano"],
  ["nl", "Nederlands"],
  ["pl", "Polski"],
  ["ru", "Русский"],
  ["uk", "Українська"],
  ["tr", "Türkçe"],
  ["ar", "العربية"],
  ["hi", "हिन्दी"],
  ["zh", "中文"],
  ["ja", "日本語"],
  ["ko", "한국어"],
] as const;

// Groups, sub-tabs and the Fleet are product foundations; only these remain optional.
const LAB_FEATURE_FLAG_IDS = ["durableScrollback", "voiceCommands"] as const;

const PROFILE_BY_ID = new Map(DEFAULT_AGENT_PROFILES.map((profile) => [profile.id, profile]));

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
  voiceLang: string;
  onVoiceLangChange: (lang: string) => void;
  voiceInputDevice: string | null;
  voiceInputDevices: readonly string[];
  onVoiceInputDeviceChange: (device: string) => void;
  micAvailable: boolean | null;
  micTesting: boolean;
  onMicTestToggle: () => void;
  voiceModels: readonly VoiceModelInfo[];
  voiceDownload: VoiceDownloadState | null;
  onVoiceModelSelect: (id: string) => void;
  onVoiceModelDownload: (id: string) => void;
  hotkeys: Readonly<Record<string, Hotkey>>;
  capturing: string | null;
  onCaptureHotkey: (id: string) => void;
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
  const t = useT();
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return undefined;
    const unlisten = listen<number>("voice-audio-level", (event) => {
      const element = fillRef.current;
      if (!element) return;
      element.style.transform = `scaleX(${Math.min(1, event.payload * 10)})`;
    });
    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, [active]);

  return (
    <div className={styles.micMeter} aria-label={t("settingsPanels.micLevel")}>
      <div className={styles.micMeterFill} ref={fillRef} />
    </div>
  );
}

function LanguageCard() {
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const setLocale = useLocaleStore((state) => state.setLocale);
  return (
    <div className={styles.card}>
      <span className={styles.cardTitle}>{t("settings.language.title")}</span>
      <label className={styles.fieldLabel}>
        {t("settings.language.label")}
        <select className={styles.select} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
          {LOCALES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <p className={styles.hint}>{t("settings.language.hint")}</p>
    </div>
  );
}

/** Font family picker: every installed family, a search box and a
 * monospace-only filter; each row renders in its own font. */
function TerminalFontPicker({ fontSize }: { fontSize: number }) {
  const t = useT();
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

  // Bring the current choice into view once the list arrives.
  useEffect(() => {
    if (fonts) selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [fonts]);

  const shown = useMemo(() => filterFonts(fonts ?? [], query, monospaceOnly), [fonts, query, monospaceOnly]);
  const missing = fonts !== null && family !== "" && !fonts.some((font) => font.name === family);
  const monoCount = fonts?.filter((font) => font.monospace).length ?? 0;

  const row = (name: string, label: string, monospace: boolean, note?: string) => {
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
        {note ? <span className={styles.fontOptionTag}>{note}</span> : monospace ? <span className={styles.fontOptionTag}>{t("settingsPanels.fontMono")}</span> : null}
      </button>
    );
  };

  return (
    <div className={styles.fontPicker}>
      <div className={styles.rowLabel}>
        <span className={styles.label}>{t("settingsPanels.fontFamily")}</span>
        <span className={styles.rowHint}>
          {fonts === null
            ? t("settingsPanels.fontLoading")
            : t("settingsPanels.fontFamilyHint", { count: fonts.length, mono: monoCount })}
        </span>
      </div>
      <div className={styles.fontFilters}>
        <input
          className={styles.textInput}
          type="search"
          aria-label={t("settingsPanels.fontSearch")}
          placeholder={t("settingsPanels.fontSearch")}
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
          {t("settingsPanels.fontMonoOnly")}
        </button>
      </div>
      <div className={styles.fontList} role="listbox" aria-label={t("settingsPanels.fontFamily")}>
        {!query ? row("", t("settingsPanels.fontDefault"), true) : null}
        {missing ? row(family, family, false, t("settingsPanels.fontMissing")) : null}
        {shown.map((font) => row(font.name, font.name, font.monospace))}
        {fonts !== null && shown.length === 0 ? <div className={styles.fontEmpty}>{t("settingsPanels.fontNoMatch")}</div> : null}
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

/** The embedded MCP server: the on/off switch and where it listens. */
function McpCard() {
  const t = useT();
  const server = useMcpStore((state) => state.server);
  const loadServer = useMcpStore((state) => state.loadServer);
  const setEnabled = useMcpStore((state) => state.setEnabled);
  useEffect(() => {
    void loadServer();
  }, [loadServer]);
  return (
    <div className={styles.card}>
      <span className={styles.cardTitle}>{t("settingsPanels.mcpTitle")}</span>
      <p className={styles.cardDescription}>{t("settingsPanels.mcpHint")}</p>
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <span className={styles.label}>{t("settingsPanels.mcpExpose")}</span>
          <span className={styles.rowHint}>{t("settingsPanels.mcpExposeHint")}</span>
        </div>
        <Toggle
          checked={server ? server.available && server.enabled : true}
          disabled={!server || !server.available}
          label={t("settingsPanels.mcpExpose")}
          onChange={(enabled) => void setEnabled(enabled)}
        />
      </div>
      {server && !server.available ? (
        <p className={styles.hint} role="alert">
          {t("settingsPanels.mcpUnavailable", { error: server.error ?? "" })}
        </p>
      ) : server ? (
        server.running && server.url ? (
          <p className={styles.hint}>
            {t("settingsPanels.mcpUrl")}: <code className={styles.agentCommand}>{server.url}</code>
            {server.port ? ` · ${t("settingsPanels.mcpPort", { port: server.port })}` : null}
          </p>
        ) : (
          <p className={styles.hint}>{t("settingsPanels.mcpNotRunning")}</p>
        )
      ) : null}
      {server?.db_path ? (
        <p className={styles.hint}>
          {t("settingsPanels.mcpDbPath")}: <code className={styles.agentCommand}>{server.db_path}</code>
        </p>
      ) : null}
    </div>
  );
}

function AgentNamesCard() {
  const t = useT();
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
      <span className={styles.cardTitle}>{t("settingsPanels.namesTitle")}</span>
      <p className={styles.cardDescription}>{t("settingsPanels.namesHint")}</p>
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <span className={styles.label}>{t("settingsPanels.autoNames")}</span>
          <span className={styles.rowHint}>{t("settingsPanels.autoNamesHint")}</span>
        </div>
        <Toggle checked={prefs.agentAutoNames} label={t("settingsPanels.autoNames")} onChange={prefs.setAgentAutoNames} />
      </div>
      {prefs.agentAutoNames ? (
        <div className={styles.stack}>
          <label className={styles.fieldLabel}>
            {t("settingsPanels.nameSet")}
            <select className={styles.select} value={prefs.agentNameSet} onChange={(event) => prefs.setAgentNameSet(event.target.value as NameSetId)}>
              <option value="stars">{t("settingsPanels.sets.stars")}</option>
              <option value="rivers">{t("settingsPanels.sets.rivers")}</option>
              <option value="custom">{t("settingsPanels.sets.custom")}</option>
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
                    aria-label={t("settingsPanels.remove", { name })}
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
              aria-label={t("settingsPanels.addName")}
              placeholder={t("settingsPanels.addName")}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addName();
              }}
            />
            <button type="button" className={styles.button} onClick={addName}>{t("settingsPanels.add")}</button>
          </div>
          <p className={styles.hint}>
            {t("settingsPanels.inUse", { count: usedCount })} · {t("settingsPanels.free", { count: prefs.agentNameList.length - usedCount })} · {t("settingsPanels.next")} <b>{next ?? "—"}</b>
          </p>
          <div className={styles.row}>
            <div className={styles.rowLabel}>
              <span className={styles.label}>{t("settingsPanels.avoidSimilar")}</span>
              <span className={styles.rowHint}>{t("settingsPanels.avoidSimilarHint")}</span>
            </div>
            <Toggle checked={prefs.avoidSimilarNames} label={t("settingsPanels.avoidSimilar")} onChange={prefs.setAvoidSimilarNames} />
          </div>
          <label className={styles.fieldLabel}>
            {t("settingsPanels.exhausted")}
            <select className={styles.select} value={prefs.namesExhausted} onChange={(event) => prefs.setNamesExhausted(event.target.value === "repeat" ? "repeat" : "type-number")}>
              <option value="type-number">{t("settingsPanels.exhaustedType")}</option>
              <option value="repeat">{t("settingsPanels.exhaustedRepeat")}</option>
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
  const t = useT();
  const profiles: AgentProfile[] = agents.map((agent) =>
    PROFILE_BY_ID.get(agent.id) ?? {
      id: agent.id,
      label: agent.label,
      command: agent.id,
      resumeCommandStrategy: { kind: "original" },
      voicePromptBehavior: { enabled: true, mode: "append", prefix: "", suffix: "" },
    },
  );
  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <span className={styles.cardTitle}>{t("settingsPanels.defaultAgentTitle")}</span>
        <p className={styles.cardDescription}>{t("settingsPanels.defaultAgentHint")}</p>
        <label className={styles.fieldLabel}>
          {t("settingsPanels.defaultAgentLabel")}
          <select
            className={styles.select}
            value={defaultAgent ?? ""}
            onChange={(event) => onDefaultAgentChange(event.target.value || null)}
          >
            <option value="">{t("settingsPanels.askEachTime")}</option>
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
        <span className={styles.cardTitle}>{t("settingsPanels.detectedTitle")}</span>
        <p className={styles.cardDescription}>{t("settingsPanels.detectedHint")}</p>
        {profiles.length === 0 ? (
          <div className={styles.empty}>{t("settingsPanels.detectedNone")}</div>
        ) : (
          <div className={styles.agentList}>
            {profiles.map((profile) => {
              const detected = agents.find((agent) => agent.id === profile.id);
              const available = detected?.available ?? true;
              return (
                <div className={styles.agentRow} key={profile.id}>
                  <div className={styles.agentIdentity}>
                    <span className={styles.agentName}>{profile.label}</span>
                    <span className={styles.agentCommand}>{profile.command || "shell"}</span>
                  </div>
                  <span className={`${styles.status} ${available ? styles.available : styles.unavailable}`}>
                    {available ? t("settingsPanels.available") : t("settingsPanels.notFound")}
                  </span>
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
  const t = useT();
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
          <div className={styles.card}>
            <span className={styles.cardTitle}>{t("settingsPanels.accessibility")}</span>
            <p className={styles.cardDescription}>{t("settingsPanels.accessibilityHint")}</p>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>{t("settingsPanels.reduceMotion")}</span>
                <span className={styles.rowHint}>{t("settingsPanels.reduceMotionHint")}</span>
              </div>
              <Toggle checked={reduceMotion} label={t("settingsPanels.reduceMotion")} onChange={onReduceMotionChange} />
            </div>
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{t("settingsPanels.labs")}</span>
            <p className={styles.cardDescription}>{t("settingsPanels.labsHint")}</p>
            <div className={styles.stack}>
              {LAB_FEATURE_FLAG_IDS.map((id) => (
                <div className={styles.row} key={id}>
                  <div className={styles.rowLabel}>
                    <span className={styles.label}>{t(`settingsPanels.flags.${id}.label`)}</span>
                    <span className={styles.rowHint}>{t(`settingsPanels.flags.${id}.description`)}</span>
                  </div>
                  <Toggle checked={flags[id]} label={t(`settingsPanels.flags.${id}.label`)} onChange={(enabled) => onFeatureFlagChange(id, enabled)} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {section.id === "terminal" && (
        <div className={styles.stack}>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{t("settingsPanels.fontTitle")}</span>
            <TerminalFontPicker fontSize={fontSize} />
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>{t("settingsPanels.fontSize")}</span>
                <span className={styles.rowHint}>{t("settingsPanels.fontRange", { size: fontSize, min: MIN_FONT_SIZE, max: MAX_FONT_SIZE })}</span>
              </div>
              <div className={styles.stepper}>
                <button className={styles.stepperButton} disabled={fontSize <= MIN_FONT_SIZE} onClick={() => onFontSizeChange(-1)} aria-label={t("settingsPanels.fontDecrease")}>−</button>
                <span className={styles.stepperValue}>{fontSize}px</span>
                <button className={styles.stepperButton} disabled={fontSize >= MAX_FONT_SIZE} onClick={() => onFontSizeChange(1)} aria-label={t("settingsPanels.fontIncrease")}>+</button>
                <button className={styles.chip} onClick={onFontSizeReset}>{t("settingsPanels.reset")}</button>
              </div>
            </div>
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{t("settingsPanels.layoutTitle")}</span>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>{t("settingsPanels.sideBySide")}</span>
                <span className={styles.rowHint}>{t("settingsPanels.sideBySideHint")}</span>
              </div>
              <div className={styles.gridOptions} aria-label={t("settingsPanels.gridColumns")}>
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
            <span className={styles.cardTitle}>{t("settingsPanels.shellTitle")}</span>
            <label className={styles.fieldLabel}>
              {t("settingsPanels.shellLabel")}
              <select className={styles.select} value={defaultShell} onChange={(event) => onDefaultShellChange(event.target.value)}>
                <option value="">{t("settingsPanels.systemDefault")}</option>
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
            <span className={styles.cardTitle}>{t("settingsPanels.voiceTitle")}</span>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>{t("settingsPanels.voiceEnable")}</span>
                <span className={styles.rowHint}>{t("settingsPanels.voiceEnableHint")}</span>
              </div>
              <Toggle checked={voiceEnabled} label={t("settingsPanels.voiceEnableLabel")} disabled={micAvailable === false && !voiceEnabled} onChange={onVoiceEnabledChange} />
            </div>
            {micAvailable === false && !voiceEnabled ? <p className={styles.hint}>{t("settingsPanels.noMic")}</p> : null}
            {voiceEnabled ? (
              <>
                <label className={styles.fieldLabel}>
                  {t("settingsPanels.voiceLanguage")}
                  <select className={styles.select} value={voiceLang} onChange={(event) => onVoiceLangChange(event.target.value)}>
                    {VOICE_LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                  </select>
                </label>
                <label className={styles.fieldLabel}>
                  {t("settingsPanels.inputDevice")}
                  <select className={styles.select} value={voiceInputDevice ?? ""} title={voiceInputDevice ?? t("settingsPanels.systemDefault")} onChange={(event) => onVoiceInputDeviceChange(event.target.value)}>
                    <option value="">{t("settingsPanels.systemDefault")}</option>
                    {voiceInputDevice && !voiceInputDevices.includes(voiceInputDevice) ? <option value={voiceInputDevice}>{t("settingsPanels.disconnected", { name: voiceInputDevice })}</option> : null}
                    {voiceInputDevices.map((device) => <option key={device} value={device}>{device}</option>)}
                  </select>
                </label>
                <div className={styles.row}>
                  <div className={styles.rowLabel}>
                    <span className={styles.label}>{t("settingsPanels.micTest")}</span>
                    <span className={styles.rowHint}>{t("settingsPanels.micTestHint")}</span>
                  </div>
                  <div className={styles.micTest}>
                    <MicLevelMeter active={micTesting} />
                    <button className={styles.chip} onClick={onMicTestToggle}>{micTesting ? t("settingsPanels.stop") : t("settingsPanels.test")}</button>
                  </div>
                </div>
                {micTesting ? <p className={styles.hint}>{t("settingsPanels.micTestBody")}</p> : null}
              </>
            ) : null}
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{t("settingsPanels.modelsTitle")}</span>
            <p className={styles.cardDescription}>{t("settingsPanels.modelsHint")}</p>
            {voiceModels.length === 0 && voiceModelsStatus === "loading" ? <div className={styles.empty}>{t("settingsPanels.modelsLoading")}</div> : null}
            {voiceModels.length === 0 && voiceModelsStatus !== "loading" ? (
              <div className={styles.empty} role="alert">
                <span>{t("settingsPanels.modelsFailed")}</span>
                {onRetryVoiceModels ? <button className={styles.chip} onClick={onRetryVoiceModels}>{t("nav.retry")}</button> : null}
              </div>
            ) : null}
            {voiceModels.length > 0 && !voiceModels.some((model) => model.downloaded) ? <p className={styles.hint}>{t("settingsPanels.modelsNone")}</p> : null}
            <div className={styles.modelList}>
              {voiceModels.map((model) => (
                <div className={styles.modelRow} key={model.id}>
                  <div className={styles.modelIdentity}>
                    <span className={styles.modelName} title={model.description}>{model.display_name}</span>
                    <span className={styles.modelMeta}>{model.size_label}</span>
                  </div>
                  {voiceDownload?.id === model.id ? <span className={styles.status}>{Math.floor(voiceDownload.percent)}%</span> : model.active ? <span className={`${styles.chip} ${styles.chipActive}`}>{t("settingsPanels.active")}</span> : model.downloaded ? <button className={styles.chip} onClick={() => onVoiceModelSelect(model.id)}>{t("settingsPanels.use")}</button> : <button className={styles.chip} disabled={voiceDownload !== null} onClick={() => onVoiceModelDownload(model.id)}>{t("settingsPanels.download")}</button>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {section.id === "agents" && <AgentPanel agents={agents} defaultAgent={defaultAgent} onDefaultAgentChange={onDefaultAgentChange} />}

      {section.id === "shortcuts" && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>{t("settingsPanels.shortcutsTitle")}</span>
          <p className={styles.cardDescription}>{t("settingsPanels.shortcutsHint")}</p>
          <div className={styles.shortcutList}>
            {HOTKEY_ACTIONS.map((action) => (
              <div className={styles.shortcutRow} key={action.id}>
                <span className={styles.shortcutIdentity}><span className={styles.shortcutName}>{hotkeyActionLabel(action.id)}</span></span>
                {capturing === action.id ? <span className={styles.status}>{t("settingsPanels.pressShortcut")}</span> : <button className={styles.chip} onClick={() => onCaptureHotkey(action.id)}>{formatHotkey(hotkeys[action.id])}</button>}
              </div>
            ))}
          </div>
          <div className={styles.actions}><button className={styles.button} onClick={onResetHotkeys}>{t("settingsPanels.restoreDefaults")}</button></div>
        </div>
      )}

      {section.id === "data" && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>{t("settingsPanels.dataTitle")}</span>
          <p className={styles.cardDescription}>{t("settingsPanels.dataHint")}</p>
          <div className={styles.actions}>
            <button className={styles.primary} disabled={snapshotOperation !== null} onClick={onExportSnapshot}>{snapshotOperation === "exporting" ? t("settingsPanels.exporting") : t("settingsPanels.exportSnapshot")}</button>
            <button className={styles.button} disabled={snapshotOperation !== null} onClick={onImportSnapshot}>{snapshotOperation === "importing" ? t("settingsPanels.importing") : t("settingsPanels.importSnapshot")}</button>
          </div>
          <p className={styles.hint}>{t("settingsPanels.importHint")}</p>
          {snapshotFeedback ? <div className={`${styles.feedback} ${snapshotFeedback.kind === "error" ? styles.feedbackError : styles.feedbackSuccess}`} role={snapshotFeedback.kind === "error" ? "alert" : "status"} aria-live="polite"><span>{snapshotFeedback.message}</span>{snapshotFeedback.backupPath ? <span className={styles.path}>{snapshotFeedback.pathKind === "backup" ? t("settingsPanels.backup") : t("settingsPanels.file")}: {snapshotFeedback.backupPath}</span> : null}</div> : null}
        </div>
      )}

      {section.id === "about" && (
        <div className={styles.stack}>
          <div className={styles.card}>
            <span className={styles.cardTitle}>Terra Swarm</span>
            <div className={styles.row}><span className={styles.label}>{t("settingsPanels.installedVersion")}</span><span className={styles.status}>{appVersion || t("settingsPanels.unknown")}</span></div>
            <p className={styles.hint}>{t("settingsPanels.localHint")}</p>
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>{t("settingsPanels.updatesTitle")}</span>
            {updateVersion ? <div className={styles.row}><span className={styles.label}>{t("settingsPanels.updateAvailable", { version: updateVersion })}</span><button className={styles.primary} disabled={updateInstalling} onClick={onInstallUpdate}>{updateInstalling ? t("settingsPanels.installing") : t("settingsPanels.updateNow")}</button></div> : <div className={styles.row}><span className={styles.status}>{updateCheckState === "checking" ? t("settingsPanels.checking") : updateCheckState === "uptodate" ? t("settingsPanels.upToDate") : updateCheckState === "error" ? t("settingsPanels.checkFailed") : t("settingsPanels.checkHourly")}</span><button className={styles.chip} disabled={updateCheckState === "checking"} onClick={onManualUpdateCheck}>{t("settingsPanels.checkNow")}</button></div>}
          </div>
        </div>
      )}
    </div>
  );
}

export type { SettingsSectionId };
