import { Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import type { PaneMenuGroups } from "../workbench/PaneActionsMenu";
import type { NavigatorAgentNode } from "./types";
import styles from "./Navigator.module.css";

const MENU_ICON_SIZE = 14;

export interface MenuPosition {
  x: number;
  y: number;
}

interface AgentContextMenuProps {
  agent: NavigatorAgentNode;
  groups: PaneMenuGroups;
  position: MenuPosition;
  onClose: () => void;
}

export function AgentContextMenu({ agent, groups, position, onClose }: AgentContextMenuProps) {
  const t = useT();
  return (
    <div
      aria-label={t("nav.agentMenu", { name: agent.name })}
      className={`${styles.contextMenu} ${styles.agentMenu}`}
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      style={{ left: position.x, top: position.y }}
    >
      {groups.map((group, index) => (
        <div className={styles.agentMenuGroup} role="group" key={group[0]?.id ?? index}>
          {group.map((item) => (
            <button
              className={styles.agentMenuItem}
              data-danger={item.danger}
              disabled={item.disabled}
              key={item.id}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              role="menuitem"
              type="button"
            >
              <span className={styles.agentMenuIcon} aria-hidden="true">{item.icon}</span>
              <span className={styles.agentMenuLabel}>{item.label}</span>
              {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

interface ProjectContextMenuProps {
  position: MenuPosition;
  onClose: () => void;
  onDelete: () => void;
}

export function ProjectContextMenu({ position, onClose, onDelete }: ProjectContextMenuProps) {
  const t = useT();
  return (
    <div
      aria-label={t("nav.projectMenu")}
      className={styles.contextMenu}
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      style={{ left: position.x, top: position.y }}
    >
      <button
        className={styles.contextMenuItem}
        onClick={() => {
          onClose();
          onDelete();
        }}
        role="menuitem"
        type="button"
      >
        <Trash2 aria-hidden="true" size={MENU_ICON_SIZE} />
        <span>{t("nav.deleteProject")}</span>
      </button>
    </div>
  );
}
