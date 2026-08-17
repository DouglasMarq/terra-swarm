import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Cpu,
  Mic,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { ShellSurface } from "../../stores/shellStore";

export interface ChromeWorkspaceTab {
  id: string;
  label: string;
  state?: "ready" | "busy" | "attention" | "paused";
  closable?: boolean;
}

export interface ResourceTelemetry {
  cpu?: string;
  memory?: string;
  active?: number;
  queued?: number;
}

export interface WindowChromeProps {
  activeSurface?: ShellSurface;
  workspaceTabs?: readonly ChromeWorkspaceTab[];
  activeWorkspaceId?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onSelectWorkspace?: (workspaceId: string) => void;
  onCloseWorkspace?: (workspaceId: string) => void;
  onReorderWorkspaceTabs?: (workspaceIds: string[]) => void;
  onNewWorkspace?: () => void;
  onToggleVoice?: () => void;
  voiceActive?: boolean;
  voiceLabel?: string;
  resources?: ResourceTelemetry;
  onOpenLauncher?: () => void;
  actions?: ReactNode;
  title?: string;
}

const surfaceLabels: Record<ShellSurface, string> = {
  home: "Início",
  workbench: "Workbench",
  fleet: "Frota",
  events: "Eventos",
  settings: "Configurações",
};

function SortableWorkspaceTab({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: ChromeWorkspaceTab;
  active: boolean;
  onSelect?: (workspaceId: string) => void;
  onClose?: (workspaceId: string) => void;
}) {
  const sortable = useSortable({
    id: tab.id,
    data: { type: "workspace-tab", workspaceId: tab.id },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  return (
    <div
      ref={sortable.setNodeRef}
      className="terra-window-tab"
      style={style}
      data-active={active}
      data-dragging={sortable.isDragging}
      role="tab"
      aria-selected={active}
      data-workspace-tab-id={tab.id}
    >
      <button
        ref={sortable.setActivatorNodeRef}
        className="terra-window-tab-main"
        type="button"
        {...sortable.attributes}
        {...sortable.listeners}
        onClick={() => onSelect?.(tab.id)}
        aria-label={`Abrir workspace ${tab.label}`}
      >
        <span
          className="terra-window-tab-state"
          data-state={tab.state ?? "ready"}
          aria-hidden="true"
        />
        <span className="terra-window-tab-label">{tab.label}</span>
      </button>
      {tab.closable !== false && (
        <button
          className="terra-window-tab-close"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose?.(tab.id);
          }}
          aria-label={`Fechar workspace ${tab.label}`}
          title="Fechar aba do workspace"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function WindowChrome({
  activeSurface = "home",
  workspaceTabs = [],
  activeWorkspaceId = null,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  onSelectWorkspace,
  onCloseWorkspace,
  onReorderWorkspaceTabs,
  onNewWorkspace,
  onToggleVoice,
  voiceActive = false,
  voiceLabel = "Voz",
  resources,
  onOpenLauncher,
  actions,
  title = "Terra",
}: WindowChromeProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const hasResourceSignal = Boolean(
    (resources?.active !== undefined && resources.active > 0) ||
      (resources?.queued !== undefined && resources.queued > 0) ||
      resources?.cpu?.trim() ||
      resources?.memory?.trim(),
  );

  function onWorkspaceTabDragEnd(event: DragEndEvent): void {
    if (!onReorderWorkspaceTabs || !event.over) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    const ids = workspaceTabs.map((tab) => tab.id);
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0 || from === to) return;
    onReorderWorkspaceTabs(arrayMove(ids, from, to));
  }

  return (
    <header className="terra-window-chrome" data-tauri-drag-region="true">
      <div className="terra-window-brand" aria-label={`${title} ${surfaceLabels[activeSurface]}`}>
        <span className="terra-window-brand-mark" aria-hidden="true">
          T
        </span>
        <span className="terra-window-brand-word">{title}</span>
      </div>

      <nav className="terra-window-history" aria-label="Histórico de navegação">
        <button
          className="terra-window-icon-button"
          type="button"
          onClick={onBack}
          disabled={!canGoBack}
          aria-label="Voltar"
          title="Voltar"
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <button
          className="terra-window-icon-button"
          type="button"
          onClick={onForward}
          disabled={!canGoForward}
          aria-label="Avançar"
          title="Avançar"
        >
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </nav>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onWorkspaceTabDragEnd}
      >
        <div className="terra-window-tab-strip" role="tablist" aria-label="Workspaces abertos">
          {workspaceTabs.length === 0 ? (
            <span className="terra-window-tab-empty" aria-live="polite">
              {surfaceLabels[activeSurface]}
            </span>
          ) : (
            <SortableContext
              items={workspaceTabs.map((tab) => tab.id)}
              strategy={horizontalListSortingStrategy}
            >
              {workspaceTabs.map((tab) => (
                <SortableWorkspaceTab
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeWorkspaceId}
                  onSelect={onSelectWorkspace}
                  onClose={onCloseWorkspace}
                />
              ))}
            </SortableContext>
          )}
          <button
            className="terra-window-tab-add"
            type="button"
            onClick={onNewWorkspace}
            aria-label="Abrir workspace"
            title="Abrir workspace"
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
      </DndContext>

      {hasResourceSignal ? <div className="terra-window-meta" aria-label="Recursos de execução">
        {resources?.active !== undefined && resources.active > 0 && (
          <span className="terra-window-meta-chip" title="Sessões ativas">
            <Activity size={12} aria-hidden="true" />
            <span className="terra-window-meta-chip-label">{resources.active} ativas</span>
          </span>
        )}
        {resources?.queued !== undefined && resources.queued > 0 && (
          <span className="terra-window-meta-chip" title="Sessões na fila">
            <ChevronDown size={12} aria-hidden="true" />
            <span className="terra-window-meta-chip-label">{resources.queued} na fila</span>
          </span>
        )}
        {resources?.cpu?.trim() && (
          <span className="terra-window-meta-chip" title="Uso de CPU">
            <Cpu size={12} aria-hidden="true" />
            <span className="terra-window-meta-chip-label">{resources.cpu}</span>
          </span>
        )}
        {resources?.memory?.trim() && (
          <span className="terra-window-meta-chip" title="Uso de memória">
            <span className="terra-window-meta-chip-label">{resources.memory}</span>
          </span>
        )}
      </div> : null}

      <button
        className="terra-window-action"
        type="button"
        onClick={onOpenLauncher}
        aria-label="Abrir ações rápidas"
        title="Ações rápidas"
      >
        <Search size={14} aria-hidden="true" />
      </button>
      <button
        className="terra-window-voice"
        type="button"
        onClick={onToggleVoice}
        data-recording={voiceActive}
        aria-pressed={voiceActive}
        aria-label={voiceLabel}
        title={voiceLabel}
      >
        <Mic size={14} aria-hidden="true" />
        <span className="terra-window-meta-chip-label">{voiceLabel}</span>
      </button>
      {actions}
    </header>
  );
}
