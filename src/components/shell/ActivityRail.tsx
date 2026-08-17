import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Boxes,
  Home,
  LayoutGrid,
  Settings,
} from "lucide-react";
import type { ShellSurface } from "../../stores/shellStore";

export interface ActivityRailItem {
  id: ShellSurface;
  label: string;
  icon: LucideIcon;
  tone?: "status";
}

export interface ActivityRailProps {
  activeSurface?: ShellSurface;
  onNavigate?: (surface: ShellSurface) => void;
  items?: readonly ActivityRailItem[];
}

const defaultItems: readonly ActivityRailItem[] = [
  { id: "home", label: "Início", icon: Home },
  { id: "workbench", label: "Workbench", icon: LayoutGrid },
  { id: "fleet", label: "Frota", icon: Boxes, tone: "status" },
  { id: "events", label: "Eventos", icon: Activity },
  { id: "settings", label: "Configurações", icon: Settings },
];

export function ActivityRail({
  activeSurface = "home",
  onNavigate,
  items = defaultItems,
}: ActivityRailProps) {
  const primaryItems = items.filter((item) => item.id !== "settings");
  const settingsItem = items.find((item) => item.id === "settings");

  return (
    <aside className="terra-activity-rail" aria-label="Superfícies do aplicativo">
      <nav className="terra-activity-nav" aria-label="Principal">
        {primaryItems.map((item) => (
          <RailButton
            key={item.id}
            item={item}
            active={activeSurface === item.id}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
      <div className="terra-activity-spacer" />
      {settingsItem && (
        <nav className="terra-activity-nav" aria-label="Preferências">
          <RailButton
            item={settingsItem}
            active={activeSurface === settingsItem.id}
            onNavigate={onNavigate}
          />
        </nav>
      )}
    </aside>
  );
}

function RailButton({
  item,
  active,
  onNavigate,
}: {
  item: ActivityRailItem;
  active: boolean;
  onNavigate?: (surface: ShellSurface) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      className="terra-activity-item"
      type="button"
      data-active={active}
      data-tone={item.tone}
      onClick={() => onNavigate?.(item.id)}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      title={item.label}
    >
      <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
    </button>
  );
}
