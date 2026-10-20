import { t } from "../../i18n";
import { normalizeSearchText } from "../../lib/text/normalizeSearchText";

export const SETTINGS_SECTION_IDS = [
  "general",
  "terminal",
  "agents",
  "voice",
  "shortcuts",
  "data",
  "about",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  /** Translated on read, so the current locale always wins. */
  readonly label: string;
  readonly description: string;
  keywords: readonly string[];
}

function section(id: SettingsSectionId, keywords: readonly string[]): SettingsSectionDefinition {
  return {
    id,
    keywords,
    get label() {
      return t(`settings.sections.${id}.label` as const);
    },
    get description() {
      return t(`settings.sections.${id}.description` as const);
    },
  };
}

/** Stable registry: ordering is part of the settings navigation contract. */
export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  section("general", ["perfil", "profile", "aparência", "appearance", "idioma", "language", "movimento", "motion", "labs", "orquestração", "fleet", "frota", "grupo"]),
  section("terminal", ["shell", "fonte", "font", "scrollback", "grade", "grid", "colunas", "pty", "comando"]),
  section("agents", ["agente", "agent", "perfil", "profile", "padrão", "default", "nome", "name", "claude", "codex"]),
  section("voice", ["microfone", "microphone", "falar", "transcrição", "transcription", "idioma", "áudio", "audio"]),
  section("shortcuts", ["teclado", "keyboard", "atalho", "shortcut", "keybind", "hotkey"]),
  section("data", ["backup", "exportar", "export", "importar", "import", "snapshot", "persistência"]),
  section("about", ["versão", "version", "atualizar", "update", "release", "sobre", "about"]),
];

export function filterSettingsSections(
  sections: readonly SettingsSectionDefinition[],
  query: string,
): SettingsSectionDefinition[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [...sections];

  return sections.filter((section) => {
    const searchable = [section.label, section.description, ...section.keywords]
      .map(normalizeSearchText)
      .join(" ");
    return searchable.includes(normalizedQuery);
  });
}

export function getInitialSettingsSection(
  sections: readonly SettingsSectionDefinition[],
  requested?: SettingsSectionId,
): SettingsSectionId | undefined {
  if (sections.length === 0) return undefined;
  return sections.some((section) => section.id === requested) ? requested : sections[0]?.id;
}

