import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

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
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  formatHotkey,
  type Hotkey,
} from "../../../stores/preferencesStore";
import type {
  SettingsSectionDefinition,
  SettingsSectionId,
} from "../../settings";
import styles from "./SettingsPanels.module.css";

export type SnapshotOperation = "exporting" | "importing";

export interface SnapshotFeedback {
  kind: "success" | "error";
  message: string;
  backupPath?: string | null;
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

const VOICE_LANGUAGES = [
  ["auto", "Detecção automática"],
  ["pt", "Português"],
  ["en", "Inglês"],
  ["es", "Espanhol"],
  ["fr", "Francês"],
  ["de", "Alemão"],
  ["it", "Italiano"],
  ["nl", "Holandês"],
  ["pl", "Polonês"],
  ["ru", "Russo"],
  ["uk", "Ucraniano"],
  ["tr", "Turco"],
  ["ar", "Árabe"],
  ["hi", "Hindi"],
  ["zh", "Chinês"],
  ["ja", "Japonês"],
  ["ko", "Coreano"],
] as const;

const FEATURE_FLAG_LABELS: Record<FeatureFlagId, { label: string; description: string }> = {
  groups: {
    label: "Grupos de workspaces",
    description: "Organize workspaces e suspenda suas sessões em conjunto.",
  },
  subTabs: {
    label: "Sub-abas",
    description: "Mantenha várias abas de agentes dentro do mesmo painel.",
  },
  durableScrollback: {
    label: "Scrollback persistente",
    description: "Conserve a saída dos terminais entre reinicializações.",
  },
  fleetView: {
    label: "Visão Fleet",
    description: "Acompanhe vários workspaces e agentes ao mesmo tempo.",
  },
  voiceCommands: {
    label: "Comandos por voz",
    description: "Use a voz para focar, abrir e orquestrar agentes.",
  },
};

// Groups, sub-tabs and Fleet are product foundations in the new shell. They
// remain in persisted legacy state for migration compatibility, but exposing
// switches that no longer govern the UI would be misleading.
const LAB_FEATURE_FLAG_IDS = ["durableScrollback", "voiceCommands"] as const;

const PROFILE_BY_ID = new Map(DEFAULT_AGENT_PROFILES.map((profile) => [profile.id, profile]));

function PanelLead({ section }: { section: SettingsSectionDefinition }) {
  return (
    <div className={styles.lead}>
      <span className={styles.eyebrow}>TERRA / {section.id.toUpperCase()}</span>
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

export function MicLevelMeter({ active }: { active: boolean }) {
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
    <div className={styles.micMeter} aria-label="Nível do microfone">
      <div className={styles.micMeterFill} ref={fillRef} />
    </div>
  );
}

function AgentPanel({
  agents,
  defaultAgent,
  onDefaultAgentChange,
}: Pick<SettingsPanelsProps, "agents" | "defaultAgent" | "onDefaultAgentChange">) {
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
        <span className={styles.cardTitle}>Agente padrão</span>
        <p className={styles.cardDescription}>
          O agente padrão é aberto diretamente ao criar uma nova sessão.
        </p>
        <label className={styles.fieldLabel}>
          Perfil usado no quick-add
          <select
            className={styles.select}
            value={defaultAgent ?? ""}
            onChange={(event) => onDefaultAgentChange(event.target.value || null)}
          >
            <option value="">Escolher a cada sessão</option>
            {agents.filter((agent) => agent.available).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label} ({agent.id})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.card}>
        <span className={styles.cardTitle}>Perfis detectados</span>
        <p className={styles.cardDescription}>
          O Terra reaproveita os perfis Luna Max disponíveis nesta máquina.
        </p>
        {profiles.length === 0 ? (
          <div className={styles.empty}>Nenhum agente foi detectado ainda.</div>
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
                    {available ? "disponível" : "não encontrado"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsSectionPanel({ section, ...props }: SettingsPanelsProps) {
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

      {section.id === "profile" && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Perfil local</span>
          <p className={styles.cardDescription}>
            O Terra Swarm funciona localmente neste dispositivo. Ainda não há uma conta remota vinculada a este perfil.
          </p>
          <div className={styles.row}>
            <div className={styles.rowLabel}>
              <span className={styles.label}>Ambiente</span>
              <span className={styles.rowHint}>Preferências e sessões ficam no armazenamento local.</span>
            </div>
            <span className={styles.status}>local</span>
          </div>
        </div>
      )}

      {section.id === "appearance" && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Acessibilidade</span>
          <p className={styles.cardDescription}>
            Ajuste o ritmo visual do workbench sem alterar a identidade Terra.
          </p>
          <div className={styles.row}>
            <div className={styles.rowLabel}>
              <span className={styles.label}>Reduzir movimento</span>
              <span className={styles.rowHint}>Minimiza animações e transições do aplicativo.</span>
            </div>
            <Toggle checked={reduceMotion} label="Reduzir movimento" onChange={onReduceMotionChange} />
          </div>
        </div>
      )}

      {section.id === "terminal" && (
        <div className={styles.stack}>
          <div className={styles.card}>
            <span className={styles.cardTitle}>Tipografia do terminal</span>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>Tamanho da fonte</span>
                <span className={styles.rowHint}>{fontSize}px · limite {MIN_FONT_SIZE}–{MAX_FONT_SIZE}px</span>
              </div>
              <div className={styles.stepper}>
                <button className={styles.stepperButton} disabled={fontSize <= MIN_FONT_SIZE} onClick={() => onFontSizeChange(-1)} aria-label="Diminuir fonte">−</button>
                <span className={styles.stepperValue}>{fontSize}px</span>
                <button className={styles.stepperButton} disabled={fontSize >= MAX_FONT_SIZE} onClick={() => onFontSizeChange(1)} aria-label="Aumentar fonte">+</button>
                <button className={styles.chip} onClick={onFontSizeReset}>Restaurar</button>
              </div>
            </div>
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>Layout do terminal</span>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>Terminais lado a lado</span>
                <span className={styles.rowHint}>Escolha quantas colunas o grid pode acomodar.</span>
              </div>
              <div className={styles.gridOptions} aria-label="Colunas do grid">
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
            <span className={styles.cardTitle}>Shell padrão</span>
            <label className={styles.fieldLabel}>
              Shell usada em novas sessões
              <select className={styles.select} value={defaultShell} onChange={(event) => onDefaultShellChange(event.target.value)}>
                <option value="">Padrão do sistema</option>
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
            <span className={styles.cardTitle}>Entrada por voz</span>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <span className={styles.label}>Ativar voz</span>
                <span className={styles.rowHint}>Transcreve fala para o terminal em foco.</span>
              </div>
              <Toggle checked={voiceEnabled} label="Ativar entrada por voz" disabled={micAvailable === false && !voiceEnabled} onChange={onVoiceEnabledChange} />
            </div>
            {micAvailable === false && !voiceEnabled ? <p className={styles.hint}>Nenhum microfone detectado. Conecte um microfone para ativar a voz.</p> : null}
            {voiceEnabled ? (
              <>
                <label className={styles.fieldLabel}>
                  Idioma
                  <select className={styles.select} value={voiceLang} onChange={(event) => onVoiceLangChange(event.target.value)}>
                    {VOICE_LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                  </select>
                </label>
                <label className={styles.fieldLabel}>
                  Dispositivo de entrada
                  <select className={styles.select} value={voiceInputDevice ?? ""} title={voiceInputDevice ?? "Padrão do sistema"} onChange={(event) => onVoiceInputDeviceChange(event.target.value)}>
                    <option value="">Padrão do sistema</option>
                    {voiceInputDevice && !voiceInputDevices.includes(voiceInputDevice) ? <option value={voiceInputDevice}>{voiceInputDevice} (desconectado)</option> : null}
                    {voiceInputDevices.map((device) => <option key={device} value={device}>{device}</option>)}
                  </select>
                </label>
                <div className={styles.row}>
                  <div className={styles.rowLabel}>
                    <span className={styles.label}>Testar microfone</span>
                    <span className={styles.rowHint}>Use fones para evitar retorno.</span>
                  </div>
                  <div className={styles.micTest}>
                    <MicLevelMeter active={micTesting} />
                    <button className={styles.chip} onClick={onMicTestToggle}>{micTesting ? "Parar" : "Testar"}</button>
                  </div>
                </div>
                {micTesting ? <p className={styles.hint}>Fale no microfone. O medidor deve acompanhar sua voz.</p> : null}
              </>
            ) : null}
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>Modelos de transcrição</span>
            <p className={styles.cardDescription}>Os modelos são baixados e usados localmente.</p>
            {voiceModels.length === 0 ? <div className={styles.empty}>Carregando modelos…</div> : null}
            {voiceModels.length > 0 && !voiceModels.some((model) => model.downloaded) ? <p className={styles.hint}>Baixe um modelo para começar a usar a entrada por voz.</p> : null}
            <div className={styles.modelList}>
              {voiceModels.map((model) => (
                <div className={styles.modelRow} key={model.id}>
                  <div className={styles.modelIdentity}>
                    <span className={styles.modelName} title={model.description}>{model.display_name}</span>
                    <span className={styles.modelMeta}>{model.size_label}</span>
                  </div>
                  {voiceDownload?.id === model.id ? <span className={styles.status}>{Math.floor(voiceDownload.percent)}%</span> : model.active ? <span className={`${styles.chip} ${styles.chipActive}`}>Ativo</span> : model.downloaded ? <button className={styles.chip} onClick={() => onVoiceModelSelect(model.id)}>Usar</button> : <button className={styles.chip} disabled={voiceDownload !== null} onClick={() => onVoiceModelDownload(model.id)}>Baixar</button>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {section.id === "agents" && <AgentPanel agents={agents} defaultAgent={defaultAgent} onDefaultAgentChange={onDefaultAgentChange} />}

      {section.id === "orchestration" && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Terra Labs</span>
          <p className={styles.cardDescription}>Recursos opcionais são salvos somente neste dispositivo. Grupos, sub-abas e Fleet fazem parte do produto e ficam sempre disponíveis.</p>
          <div className={styles.stack}>
            {LAB_FEATURE_FLAG_IDS.map((id) => {
              const feature = FEATURE_FLAG_LABELS[id];
              return (
                <div className={styles.row} key={id}>
                  <div className={styles.rowLabel}>
                    <span className={styles.label}>{feature.label}</span>
                    <span className={styles.rowHint}>{feature.description}</span>
                  </div>
                  <Toggle checked={flags[id]} label={feature.label} onChange={(enabled) => onFeatureFlagChange(id, enabled)} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {section.id === "shortcuts" && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Atalhos de teclado</span>
          <p className={styles.cardDescription}>Clique em um atalho e pressione a nova combinação. Esc cancela a captura.</p>
          <div className={styles.shortcutList}>
            {HOTKEY_ACTIONS.map((action) => (
              <div className={styles.shortcutRow} key={action.id}>
                <span className={styles.shortcutIdentity}><span className={styles.shortcutName}>{action.label}</span></span>
                {capturing === action.id ? <span className={styles.status}>Pressione o atalho…</span> : <button className={styles.chip} onClick={() => onCaptureHotkey(action.id)}>{formatHotkey(hotkeys[action.id])}</button>}
              </div>
            ))}
          </div>
          <div className={styles.actions}><button className={styles.button} onClick={onResetHotkeys}>Restaurar padrões</button></div>
        </div>
      )}

      {section.id === "data" && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Portabilidade dos workspaces</span>
          <p className={styles.cardDescription}>Exporte grupos, layouts, abas e metadados como um snapshot JSON versionado. Processos ativos e saída dos PTYs nunca são copiados.</p>
          <div className={styles.actions}>
            <button className={styles.primary} disabled={snapshotOperation !== null} onClick={onExportSnapshot}>{snapshotOperation === "exporting" ? "Exportando…" : "Exportar snapshot"}</button>
            <button className={styles.button} disabled={snapshotOperation !== null} onClick={onImportSnapshot}>{snapshotOperation === "importing" ? "Importando…" : "Importar snapshot"}</button>
          </div>
          <p className={styles.hint}>A importação substitui os metadados após uma confirmação explícita e cria um backup recuperável.</p>
          {snapshotFeedback ? <div className={`${styles.feedback} ${snapshotFeedback.kind === "error" ? styles.feedbackError : styles.feedbackSuccess}`} role={snapshotFeedback.kind === "error" ? "alert" : "status"} aria-live="polite"><span>{snapshotFeedback.message}</span>{snapshotFeedback.backupPath ? <span className={styles.path}>{snapshotFeedback.message.startsWith("Snapshot importado") ? "Backup" : "Arquivo"}: {snapshotFeedback.backupPath}</span> : null}</div> : null}
        </div>
      )}

      {section.id === "updates" && (
        <div className={styles.stack}>
          <div className={styles.card}>
            <span className={styles.cardTitle}>Terra Swarm</span>
            <div className={styles.row}><span className={styles.label}>Versão instalada</span><span className={styles.status}>{appVersion || "desconhecida"}</span></div>
            <p className={styles.hint}>A identidade e as preferências deste app são locais ao ambiente Terra.</p>
          </div>
          <div className={styles.card}>
            <span className={styles.cardTitle}>Atualizações</span>
            {updateVersion ? <div className={styles.row}><span className={styles.label}>Versão {updateVersion} disponível</span><button className={styles.primary} disabled={updateInstalling} onClick={onInstallUpdate}>{updateInstalling ? "Instalando…" : "Atualizar agora"}</button></div> : <div className={styles.row}><span className={styles.status}>{updateCheckState === "checking" ? "Verificando atualizações…" : updateCheckState === "uptodate" ? "Você está em dia" : updateCheckState === "error" ? "Não foi possível verificar" : "Verificação automática a cada hora"}</span><button className={styles.chip} disabled={updateCheckState === "checking"} onClick={onManualUpdateCheck}>Verificar agora</button></div>}
          </div>
        </div>
      )}
    </div>
  );
}

export type { SettingsSectionId };
