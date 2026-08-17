import {
  Bot,
  Database,
  Keyboard,
  Mic2,
  Network,
  Palette,
  RefreshCw,
  SquareTerminal,
  UserRound,
  type LucideIcon,
} from "lucide-react";

export const SETTINGS_SECTION_IDS = [
  "profile",
  "appearance",
  "terminal",
  "voice",
  "agents",
  "orchestration",
  "shortcuts",
  "data",
  "updates",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  label: string;
  description: string;
  keywords: readonly string[];
  icon: LucideIcon;
}

/** Stable registry: ordering and labels are part of the settings navigation contract. */
export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: "profile",
    label: "Perfil",
    description: "Identidade, conta local e preferências pessoais.",
    keywords: ["conta", "identidade", "nome", "usuário", "utilizador"],
    icon: UserRound,
  },
  {
    id: "appearance",
    label: "Aparência",
    description: "Tema, densidade e linguagem visual do Terra.",
    keywords: ["tema", "visual", "cor", "densidade", "interface"],
    icon: Palette,
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Shell, fonte, scrollback e comportamento dos terminais.",
    keywords: ["shell", "fonte", "scrollback", "cursor", "pty", "comando"],
    icon: SquareTerminal,
  },
  {
    id: "voice",
    label: "Voz",
    description: "Entrada por voz, idioma e confirmação de comandos.",
    keywords: ["microfone", "falar", "transcrição", "idioma", "áudio"],
    icon: Mic2,
  },
  {
    id: "agents",
    label: "Agentes",
    description: "Perfis Luna Max, prompts e regras de execução.",
    keywords: ["luna", "modelo", "prompt", "agente", "perfil", "ia"],
    icon: Bot,
  },
  {
    id: "orchestration",
    label: "Orquestração",
    description: "Ondas, grupos, filas e coordenação do fleet.",
    keywords: ["fleet", "grupo", "onda", "fila", "paralelo", "coordenação"],
    icon: Network,
  },
  {
    id: "shortcuts",
    label: "Atalhos",
    description: "Teclas rápidas para navegar e operar o workbench.",
    keywords: ["teclado", "atalho", "keybind", "navegação", "comando"],
    icon: Keyboard,
  },
  {
    id: "data",
    label: "Dados",
    description: "Persistência local, exportação e limpeza de dados.",
    keywords: ["backup", "exportar", "importar", "persistência", "limpar", "privacidade"],
    icon: Database,
  },
  {
    id: "updates",
    label: "Atualizações",
    description: "Versão instalada, canais e atualizações do aplicativo.",
    keywords: ["versão", "atualizar", "release", "canal", "download"],
    icon: RefreshCw,
  },
] as const;

/** Search is accent-insensitive and locale-aware for Portuguese labels and commands. */
export function normalizeSettingsSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function filterSettingsSections(
  sections: readonly SettingsSectionDefinition[],
  query: string,
): SettingsSectionDefinition[] {
  const normalizedQuery = normalizeSettingsSearch(query);
  if (!normalizedQuery) return [...sections];

  return sections.filter((section) => {
    const searchable = [section.label, section.description, ...section.keywords]
      .map(normalizeSettingsSearch)
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

export function getSettingsSection(
  sections: readonly SettingsSectionDefinition[],
  id: string | undefined,
): SettingsSectionDefinition | undefined {
  return sections.find((section) => section.id === id);
}

