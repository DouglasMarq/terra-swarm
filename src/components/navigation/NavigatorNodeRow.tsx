import { useT, type Translate } from "../../i18n";
import { Bot, ChevronDown, ChevronRight, Folder, FolderOpen, GitBranch, MoreHorizontal, Pause, Play, Plus, SquareTerminal, Workflow } from "../../components/icons";
import { Eye, EyeOff, Pencil, Trash2 } from "lucide-react";
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

function labelFor(node: NavigatorNode, t: Translate): string {
  if (node.kind === "agent") return t("nav.agentNode", { name: node.name });
  if (node.kind === "project") return t("nav.projectNode", { name: node.name });
  if (node.kind === "container") return t("nav.containerNode", { name: node.name });
  if (node.kind === "pane") return t("nav.paneNode", { name: node.name });
  return t("nav.groupNode", { name: node.name });
}

function countLabel(node: NavigatorNode, t: Translate): string {
  if (node.kind === "agent") return "";
  return t("nav.agentCount", { count: node.count });
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

function rowActions(node: NavigatorNode, actions: NavigatorNodeActions, t: Translate): ReactNode[] {
  const ref = navigatorRef(node);
  const result: ReactNode[] = [];
  if ((node.kind === "group" || node.kind === "project") && actions.onCreate) {
    result.push(actionButton("create", t("nav.createInside"), <Plus aria-hidden="true" size={13} />, (event) => {
      stop(event);
      actions.onCreate?.(ref);
    }));
  }
  // The host only persists names for groups and projects. Containers, panes
  // and agents are structural/runtime nodes, so do not advertise a rename
  // action that would open an unsupported dialog or silently do nothing.
  if (actions.onRename && (node.kind === "group" || node.kind === "project")) {
    result.push(actionButton("rename", t("nav.rename"), <Pencil aria-hidden="true" size={13} />, (event) => {
      stop(event);
      actions.onRename?.(ref);
    }));
  }
  if (node.kind === "project" && actions.onDelete) {
    result.push(actionButton("delete", t("nav.deleteProject"), <Trash2 aria-hidden="true" size={13} />, (event) => {
      stop(event);
      actions.onDelete?.(ref);
    }));
  }
  if (node.kind === "project" && actions.onHide) {
    const visible = (node as NavigatorProjectNode).visible;
    result.push(actionButton(visible ? "hide" : "show", visible ? t("nav.hideProject") : t("nav.showProject"), visible ? <EyeOff aria-hidden="true" size={13} /> : <Eye aria-hidden="true" size={13} />, (event) => {
      stop(event);
      actions.onHide?.(ref);
    }));
  }
  if (node.kind === "group") {
    const group = node as NavigatorGroupNode;
    if (group.suspended && actions.onResume) {
      result.push(actionButton("resume", t("nav.resumeGroup"), <Play aria-hidden="true" size={13} />, (event) => {
        stop(event);
        actions.onResume?.(ref);
      }));
    } else if (!group.suspended && actions.onSuspend) {
      result.push(actionButton("suspend", t("nav.suspendGroup"), <Pause aria-hidden="true" size={13} />, (event) => {
        stop(event);
        actions.onSuspend?.(ref);
      }));
    }
  }
  if (actions.onContextMenu) {
    result.push(actionButton("context", t("nav.contextMenu"), <MoreHorizontal aria-hidden="true" size={13} />, (event) => {
      stop(event);
      actions.onContextMenu?.(event, ref);
    }));
  }
  return result;
}

export function NavigatorNodeRow({
  node,
  expanded,
  selected,
  active,
  visible,
  actions,
  onToggle,
  onSelect,
  style,
}: NavigatorRowProps) {
  const t = useT();
  const canToggle = node.children.length > 0;
  const ref = navigatorRef(node);
  const className = [
    styles.row,
    styles[node.kind],
    styles[node.status],
    selected ? styles.selected : "",
    active ? styles.active : "",
    visible ? "" : styles.hiddenRow,
  ].filter(Boolean).join(" ");
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keys on the row's own buttons (rename, delete, …) belong to them.
    if (event.target !== event.currentTarget) return;
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
    }
  }

  return (
    <div
      aria-expanded={canToggle ? expanded : undefined}
      aria-label={labelFor(node, t)}
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
      role="treeitem"
      tabIndex={0}
      style={{ ...style, paddingInlineStart: `${8 + node.depth * 18}px` }}
    >
      <span className={styles.indent} aria-hidden="true" />
      <button
        aria-label={canToggle ? (expanded ? t("nav.collapse") : t("nav.expand")) : undefined}
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
      <span className={`${styles.statusDot} ${styles[`status${node.status}`]}`} title={t(`status.${node.status}` as const)} aria-label={t(`status.${node.status}` as const)} role="img" />
      <span className={styles.nodeIcon}><IconForNode expanded={expanded} node={node} /></span>
      <span className={styles.nodeMain}>
        <span className={styles.nodeName}>{node.name}</span>
      {node.kind === "agent" && (node as NavigatorAgentNode).tag ? (
          <span className={styles.nodeSubline}>{(node as NavigatorAgentNode).tag}</span>
        ) : node.kind === "agent" && (node as NavigatorAgentNode).branchIds.length > 0 ? (
          <span className={styles.nodeSubline}><GitBranch aria-hidden="true" size={11} /> {t("nav.branches", { count: (node as NavigatorAgentNode).branchIds.length })}</span>
        ) : null}
      </span>
      {!visible && node.kind === "project" ? <EyeOff aria-label={t("nav.hidden")} className={styles.visibilityIcon} size={12} /> : null}
      {node.kind === "agent" && (node as NavigatorAgentNode).notifications > 0 ? <span className={styles.notificationBadge}>{(node as NavigatorAgentNode).notifications}</span> : null}
      {node.kind === "agent" && (node as NavigatorAgentNode).contextUsage !== null ? (
        <span className={((node as NavigatorAgentNode).contextUsage ?? 0) >= 85 ? styles.contextBadge : styles.contextValue} title={t("inspector.context")}>
          {(node as NavigatorAgentNode).contextUsage}%
        </span>
      ) : null}
      <span className={styles.nodeCount}>{countLabel(node, t)}</span>
      <span className={styles.actions} onClick={(event) => event.stopPropagation()}>{rowActions(node, actions, t)}</span>
    </div>
  );
}
