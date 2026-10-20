import {
  Bot,
  Database,
  Info,
  Keyboard,
  Mic2,
  SlidersHorizontal,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
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
  icon: LucideIcon;
}

function section(
  id: SettingsSectionId,
  icon: LucideIcon,
  keywords: readonly string[],
): SettingsSectionDefinition {
  return {
    id,
    icon,
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
  section("general", SlidersHorizontal, ["perfil", "profile", "aparência", "appearance", "idioma", "language", "movimento", "motion", "labs", "orquestração", "fleet", "frota", "grupo"]),
  section("terminal", SquareTerminal, ["shell", "fonte", "font", "scrollback", "grade", "grid", "colunas", "pty", "comando"]),
  section("agents", Bot, ["agente", "agent", "perfil", "profile", "padrão", "default", "nome", "name", "claude", "codex"]),
  section("voice", Mic2, ["microfone", "microphone", "falar", "transcrição", "transcription", "idioma", "áudio", "audio"]),
  section("shortcuts", Keyboard, ["teclado", "keyboard", "atalho", "shortcut", "keybind", "hotkey"]),
  section("data", Database, ["backup", "exportar", "export", "importar", "import", "snapshot", "persistência"]),
  section("about", Info, ["versão", "version", "atualizar", "update", "release", "sobre", "about"]),
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

