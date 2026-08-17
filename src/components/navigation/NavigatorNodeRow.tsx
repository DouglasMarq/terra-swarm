import { CSS } from "@dnd-kit/utilities";
import { Bot, ChevronDown, ChevronRight, Folder, FolderOpen, GitBranch, MoreHorizontal, Pause, Play, Plus, SquareTerminal, Workflow } from "../../components/icons";
import { Eye, EyeOff, Pencil } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { NavigatorAgentNode, NavigatorGroupNode, NavigatorNode, NavigatorNodeActions, NavigatorProjectNode, NavigatorRowProps } from "./types";
import { navigatorRef } from "./types";
import styles from "./Navigator.module.css";

function stop(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation();
}

function IconForNode({ node, expanded }: { node: NavigatorNode; expanded: boolean }) {
  if (node.kind === "agent") return <Bot aria-hidden="true" size={15} strokeWidth={1.8} />;
  if (node.kind === "container") return <Workflow aria-hidden="true" size={15} strokeWidth={1.8} />;
  if (node.kind === "pane") return <SquareTerminal aria-hidden="true" size={15} strokeWidth={1.8} />;
  if (node.kind === "group") {
    return expanded ? <FolderOpen aria-hidden="true" size={15} strokeWidth={1.8} /> : <Folder aria-hidden="true" size={15} strokeWidth={1.8} />;
  }
  return <Folder aria-hidden="true" size={15} strokeWidth={1.8} />;
}

function labelFor(node: NavigatorNode): string {
  if (node.kind === "agent") return `Agente ${node.name}`;
  if (node.kind === "project") return `Projeto ${node.name}`;
  if (node.kind === "container") return `Container ${node.name}`;
  if (node.kind === "pane") return `Pane ${node.name}`;
  return `Grupo ${node.name}`;
}

function countLabel(node: NavigatorNode): string {
  if (node.kind === "agent") return "";
  return node.kind === "project" ? `${node.count} agente${node.count === 1 ? "" : "s"}` : `${node.count} agente${node.count === 1 ? "" : "s"}`;
}

function actionButton(
  key: string,
  label: string,
  icon: ReactNode,
  onClick: (event: MouseEvent<HTMLButtonElement>) => void,
) {
  return (
    <button key={key} aria-label={label} className={styles.rowAction} onClick={onClick} type="button">
      {icon}
    </button>
  );
}

function rowActions(node: NavigatorNode, actions: NavigatorNodeActions): ReactNode[] {
  const ref = navigatorRef(node);
  const result: ReactNode[] = [];
  if ((node.kind === "group" || node.kind === "project") && actions.onCreate) {
    result.push(actionButton("create", "Criar dentro", <Plus aria-hidden="true" size={13} />, (event) => {
      stop(event);
      actions.onCreate?.(ref);
    }));
  }
  // The host only persists names for groups and projects. Containers, panes
  // and agents are structural/runtime nodes, so do not advertise a rename
  // action that would open an unsupported dialog or silently do nothing.
  if (actions.onRename && (node.kind === "group" || node.kind === "project")) {
    result.push(actionButton("rename", "Renomear", <Pencil aria-hidden="true" size={13} />, (event) => {
      stop(event);
      actions.onRename?.(ref);
    }));
  }
  if (node.kind === "project" && actions.onHide) {
    const visible = (node as NavigatorProjectNode).visible;
    result.push(actionButton(visible ? "hide" : "show", visible ? "Ocultar projeto" : "Mostrar projeto", visible ? <EyeOff aria-hidden="true" size={13} /> : <Eye aria-hidden="true" size={13} />, (event) => {
      stop(event);
      actions.onHide?.(ref);
    }));
  }
  if (node.kind === "group") {
    const group = node as NavigatorGroupNode;
    if (group.suspended && actions.onResume) {
      result.push(actionButton("resume", "Retomar grupo", <Play aria-hidden="true" size={13} />, (event) => {
        stop(event);
        actions.onResume?.(ref);
      }));
    } else if (!group.suspended && actions.onSuspend) {
      result.push(actionButton("suspend", "Suspender grupo", <Pause aria-hidden="true" size={13} />, (event) => {
        stop(event);
        actions.onSuspend?.(ref);
      }));
    }
  }
  if (actions.onContextMenu) {
    result.push(actionButton("context", "Abrir menu de contexto", <MoreHorizontal aria-hidden="true" size={13} />, (event) => {
      stop(event);
      actions.onContextMenu?.(event, ref);
    }));
  }
  return result;
}

export function NavigatorNodeRow({
  node,
  dragEnabled = false,
  expanded,
  selected,
  active,
  visible,
  actions,
  onToggle,
  onSelect,
  dropIntent,
  style,
}: NavigatorRowProps) {
  const sortable = useSortable({
    id: node.dragId,
    // Only projects have a persisted reorder/assignment handler. Groups and
    // agents remain valid drop targets, but never advertise a drag affordance
    // that would be discarded by the host.
    disabled: {
      draggable: node.kind !== "project" || !dragEnabled,
      droppable: !dragEnabled || (node.kind !== "group" && node.kind !== "project"),
    },
    data: { nodeId: node.id, nodeKind: node.kind },
  });
  const transform = CSS.Transform.toString(sortable.transform);
  const canToggle = node.children.length > 0;
  const ref = navigatorRef(node);
  const className = [
    styles.row,
    styles[node.kind],
    styles[node.status],
    selected ? styles.selected : "",
    active ? styles.active : "",
    visible ? "" : styles.hiddenRow,
    dropIntent ? styles[`drop${dropIntent[0].toUpperCase()}${dropIntent.slice(1)}`] : "",
  ].filter(Boolean).join(" ");
  const dragAttributes = node.kind === "project" && dragEnabled ? sortable.attributes : {};
  const dragListeners = node.kind === "project" && dragEnabled ? sortable.listeners : undefined;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (node.kind === "group" && canToggle) onToggle?.(node.id);
      else actions.onOpen?.(ref);
      return;
    }
    if (event.key === "ArrowRight" && canToggle && !expanded) {
      event.preventDefault();
      onToggle?.(node.id);
    } else if (event.key === "ArrowLeft" && canToggle && expanded) {
      event.preventDefault();
      onToggle?.(node.id);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      // dnd-kit owns the sortable keyboard movement. Keeping the key event
      // available here lets its KeyboardSensor move through treeitems.
      return;
    }
  }

  return (
    <div
      {...dragAttributes}
      {...dragListeners}
      aria-expanded={canToggle ? expanded : undefined}
      aria-label={labelFor(node)}
      aria-level={node.depth + 1}
      aria-selected={selected}
      className={className}
      data-depth={node.depth}
      data-node-id={node.id}
      data-node-kind={node.kind}
      data-status={node.status}
      onClick={() => {
        onSelect?.(node);
        if (node.kind === "group") {
          if (canToggle) onToggle?.(node.id);
        } else {
          // A project click opens its workspace; the disclosure button is the
          // explicit affordance for expanding its agent children.
          actions.onOpen?.(ref);
        }
      }}
      onContextMenu={(event) => actions.onContextMenu?.(event, ref)}
      onKeyDown={handleKeyDown}
      ref={sortable.setNodeRef}
      role="treeitem"
      tabIndex={node.kind === "project" && dragEnabled ? undefined : 0}
      style={{ ...style, paddingInlineStart: `${8 + node.depth * 18}px`, transform: transform ?? undefined, transition: sortable.transition ?? undefined }}
    >
      <span className={styles.indent} aria-hidden="true" />
      <button
        aria-label={canToggle ? (expanded ? "Recolher" : "Expandir") : undefined}
        className={styles.disclosure}
        disabled={!canToggle}
        onClick={(event) => {
          stop(event);
          if (canToggle) onToggle?.(node.id);
        }}
        tabIndex={-1}
        type="button"
      >
        {canToggle ? (expanded ? <ChevronDown aria-hidden="true" size={13} /> : <ChevronRight aria-hidden="true" size={13} />) : <span className={styles.disclosureSpacer} />}
      </button>
      <span className={`${styles.statusDot} ${styles[`status${node.status}`]}`} title={node.status} aria-label={node.status} role="img" />
      <span className={styles.nodeIcon}><IconForNode expanded={expanded} node={node} /></span>
      <span className={styles.nodeMain}>
        <span className={styles.nodeName}>{node.name}</span>
      {node.kind === "agent" && (node as NavigatorAgentNode).branchIds.length > 0 ? (
          <span className={styles.nodeSubline}><GitBranch aria-hidden="true" size={11} /> {(node as NavigatorAgentNode).branchIds.length} branch{(node as NavigatorAgentNode).branchIds.length === 1 ? "" : "es"}</span>
        ) : null}
      </span>
      {!visible && node.kind === "project" ? <EyeOff aria-label="Oculto" className={styles.visibilityIcon} size={12} /> : null}
      {node.kind === "agent" && (node as NavigatorAgentNode).notifications > 0 ? <span className={styles.notificationBadge}>{(node as NavigatorAgentNode).notifications}</span> : null}
      {node.kind === "agent" && (node as NavigatorAgentNode).contextUsage !== null && ((node as NavigatorAgentNode).contextUsage ?? 0) >= 85 ? <span className={styles.contextBadge}>ctx</span> : null}
      <span className={styles.nodeCount}>{countLabel(node)}</span>
      <span className={styles.actions} onClick={(event) => event.stopPropagation()}>{rowActions(node, actions)}</span>
    </div>
  );
}
