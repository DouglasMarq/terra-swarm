import type { ReactNode } from "react";
import {
  Braces,
  CircleHelp,
  Eye,
  FileClock,
  Mic,
  PanelRightClose,
} from "lucide-react";
import type { DockTab } from "../../stores/shellStore";

export interface RightDockPanel {
  id: DockTab;
  label: string;
  count?: number;
  content?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
}

export interface RightDockProps {
  open?: boolean;
  activeTab?: DockTab;
  onTabChange?: (tab: DockTab) => void;
  onOpen?: () => void;
  onClose?: () => void;
  panels?: readonly RightDockPanel[];
  /** Retained for callers that still pass focus metadata; panels own its presentation. */
  selectedLabel?: string | null;
}

const defaultPanels: readonly RightDockPanel[] = [
  {
    id: "inspector",
    label: "Inspetor",
    emptyTitle: "Nada selecionado",
    emptyDescription: "Selecione um workspace, pane ou sessão para inspecionar os detalhes de execução.",
  },
  {
    id: "events",
    label: "Eventos",
    emptyTitle: "Nenhum evento recente",
    emptyDescription: "Mudanças de ciclo de vida e sinais dos agentes aparecerão aqui.",
  },
  {
    id: "context",
    label: "Contexto",
    emptyTitle: "Contexto livre",
    emptyDescription: "Abra uma sessão para ver o orçamento de contexto e as notas de repasse.",
  },
  {
    id: "voice",
    label: "Voz",
    emptyTitle: "Voz pronta",
    emptyDescription: "Use o controle de voz na barra da janela para iniciar um comando.",
  },
];

const panelIcons = {
  inspector: Eye,
  events: FileClock,
  context: Braces,
  voice: Mic,
} as const;

export function RightDock({
  open = true,
  activeTab = "inspector",
  onTabChange,
  onClose,
  panels = defaultPanels,
}: RightDockProps) {
  if (!open) return null;
  const current = panels.find((panel) => panel.id === activeTab) ?? panels[0];
  if (!current) return null;
  const Icon = panelIcons[current.id];

  return (
    <aside className="terra-right-dock" aria-label="Painel contextual">
      <div className="terra-right-dock-header">
        <button
          className="terra-right-dock-close"
          type="button"
          onClick={onClose}
          aria-label="Fechar painel contextual"
          title="Fechar painel contextual"
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="terra-right-dock-tabs" role="tablist" aria-label="Abas do painel contextual">
        {panels.map((panel) => {
          const TabIcon = panelIcons[panel.id];
          const active = panel.id === current.id;
          const tabId = `terra-right-dock-tab-${panel.id}`;
          const panelId = `terra-right-dock-panel-${panel.id}`;
          return (
            <button
              className="terra-right-dock-tab"
              id={tabId}
              key={panel.id}
              type="button"
              role="tab"
              data-active={active}
              aria-selected={active}
              aria-controls={panelId}
              onClick={() => onTabChange?.(panel.id)}
              title={panel.label}
            >
              <TabIcon size={13} aria-hidden="true" />
              <span className="terra-right-dock-tab-label">{panel.label}</span>
              {panel.count !== undefined && panel.count > 0 && (
                <span aria-label={`${panel.count} itens`}>{panel.count}</span>
              )}
            </button>
          );
        })}
      </div>
      <div
        className="terra-right-dock-content"
        id={`terra-right-dock-panel-${current.id}`}
        role="tabpanel"
        aria-labelledby={`terra-right-dock-tab-${current.id}`}
        tabIndex={0}
      >
        {current.content ?? (
          <div className="terra-right-dock-empty">
            <Icon size={20} strokeWidth={1.4} aria-hidden="true" />
            <strong>{current.emptyTitle ?? "Ainda não há dados"}</strong>
            <span>{current.emptyDescription ?? "Este painel será preenchido conforme a Terra receber atividade."}</span>
            <CircleHelp size={13} aria-hidden="true" />
          </div>
        )}
      </div>
    </aside>
  );
}
