import { useT, type Translate } from "../../i18n";
import { Bot, ChevronDown, ChevronRight, Folder, FolderOpen, GitBranch, MoreHorizontal, Pause, Play, Plus, SquareTerminal, Workflow } from "../../components/icons";
import { Eye, EyeOff, Pencil, Trash2 } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { CONTEXT_ATTENTION_PERCENT } from "../../domain/agentStatus";
import type { NavigatorAgentNode, NavigatorGroupNode, NavigatorNode, NavigatorNodeActions, NavigatorProjectNode, NavigatorRowProps } from "./types";
import { navigatorRef } from "./types";
import { indentFor } from "./indent";
import styles from "./Navigator.module.css";

function stop(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation();
}

function IconForNode({ node, isExpanded }: { node: NavigatorNode; isExpanded: boolean }) {
  if (node.kind === "agent") return <Bot aria-hidden="true" size={15} strokeWidth={1.8} />;
  if (node.kind === "container") return <Workflow aria-hidden="true" size={15} strokeWidth={1.8} />;
  if (node.kind === "pane") return <SquareTerminal aria-hidden="true" size={15} strokeWidth={1.8} />;
  if (node.kind === "group") {
    return isExpanded ? <FolderOpen aria-hidden="true" size={15} strokeWidth={1.8} /> : <Folder aria-hidden="true" size={15} strokeWidth={1.8} />;
  }
  return <Folder aria-hidden="true" size={15} strokeWidth={1.8} />;
}

function labelFor(node: NavigatorNode, translate: Translate): string {
  if (node.kind === "agent") return translate("nav.agentNode", { name: node.name });
  if (node.kind === "project") return translate("nav.projectNode", { name: node.name });
  if (node.kind === "container") return translate("nav.containerNode", { name: node.name });
  if (node.kind === "pane") return translate("nav.paneNode", { name: node.name });
  return translate("nav.groupNode", { name: node.name });
}

function countLabel(node: NavigatorNode, translate: Translate): string {
  if (node.kind === "agent") return "";
  return translate("nav.agentCount", { count: node.count });
}

interface RowAction {
  id: string;
  label: string;
  icon: ReactNode;
  run: (event: MouseEvent<HTMLButtonElement>) => void;
}

function rowActionButton(action: RowAction) {
  return (
    <button
      key={action.id}
      aria-label={action.label}
      className={styles.rowAction}
      onClick={(event) => {
        stop(event);
        action.run(event);
      }}
      type="button"
    >
      {action.icon}
    </button>
  );
}

function editActions(node: NavigatorNode, actions: NavigatorNodeActions, translate: Translate): RowAction[] {
  if (node.kind !== "group" && node.kind !== "project") return [];
  const ref = navigatorRef(node);
  const result: RowAction[] = [];
  if (actions.onCreate) {
    result.push({ id: "create", label: translate("nav.createInside"), icon: <Plus aria-hidden="true" size={13} />, run: () => actions.onCreate?.(ref) });
  }
  // The host only persists names for groups and projects. Containers, panes
  // and agents are structural/runtime nodes, so do not advertise a rename
  // action that would open an unsupported dialog or silently do nothing.
  if (actions.onRename) {
    result.push({ id: "rename", label: translate("nav.rename"), icon: <Pencil aria-hidden="true" size={13} />, run: () => actions.onRename?.(ref) });
  }
  return result;
}

function projectActions(node: NavigatorProjectNode, actions: NavigatorNodeActions, translate: Translate): RowAction[] {
  const ref = navigatorRef(node);
  const result: RowAction[] = [];
  if (actions.onDelete) {
    result.push({ id: "delete", label: translate("nav.deleteProject"), icon: <Trash2 aria-hidden="true" size={13} />, run: () => actions.onDelete?.(ref) });
  }
  if (actions.onHide) {
    result.push(node.isVisible
      ? { id: "hide", label: translate("nav.hideProject"), icon: <EyeOff aria-hidden="true" size={13} />, run: () => actions.onHide?.(ref) }
      : { id: "show", label: translate("nav.showProject"), icon: <Eye aria-hidden="true" size={13} />, run: () => actions.onHide?.(ref) });
  }
  return result;
}

function groupActions(node: NavigatorGroupNode, actions: NavigatorNodeActions, translate: Translate): RowAction[] {
  const ref = navigatorRef(node);
  if (node.isSuspended && actions.onResume) {
    return [{ id: "resume", label: translate("nav.resumeGroup"), icon: <Play aria-hidden="true" size={13} />, run: () => actions.onResume?.(ref) }];
  }
  if (!node.isSuspended && actions.onSuspend) {
    return [{ id: "suspend", label: translate("nav.suspendGroup"), icon: <Pause aria-hidden="true" size={13} />, run: () => actions.onSuspend?.(ref) }];
  }
  return [];
}

function kindActions(node: NavigatorNode, actions: NavigatorNodeActions, translate: Translate): RowAction[] {
  if (node.kind === "project") return projectActions(node, actions, translate);
  if (node.kind === "group") return groupActions(node, actions, translate);
  return [];
}

function contextActions(node: NavigatorNode, actions: NavigatorNodeActions, translate: Translate): RowAction[] {
  if (!actions.onContextMenu) return [];
  const ref = navigatorRef(node);
  return [{ id: "context", label: translate("nav.contextMenu"), icon: <MoreHorizontal aria-hidden="true" size={13} />, run: (event) => actions.onContextMenu?.(event, ref) }];
}

function rowActions(node: NavigatorNode, actions: NavigatorNodeActions, translate: Translate): ReactNode[] {
  return [
    ...editActions(node, actions, translate),
    ...kindActions(node, actions, translate),
    ...contextActions(node, actions, translate),
  ].map(rowActionButton);
}

function AgentSubline({ node, translate }: { node: NavigatorAgentNode; translate: Translate }) {
  if (node.tag) return <span className={styles.nodeSubline}>{node.tag}</span>;
  if (node.branchIds.length === 0) return null;
  return <span className={styles.nodeSubline}><GitBranch aria-hidden="true" size={11} /> {translate("nav.branches", { count: node.branchIds.length })}</span>;
}

function AgentBadges({ node, translate }: { node: NavigatorAgentNode; translate: Translate }) {
  return (
    <>
      {node.notifications > 0 ? <span className={styles.notificationBadge}>{node.notifications}</span> : null}
      {node.contextUsage !== null ? (
        <span className={node.contextUsage >= CONTEXT_ATTENTION_PERCENT ? styles.contextBadge : styles.contextValue} title={translate("inspector.context")}>
          {node.contextUsage}%
        </span>
      ) : null}
    </>
  );
}

export function NavigatorNodeRow({
  node,
  isExpanded,
  isSelected,
  isActive,
  isVisible,
  actions,
  onToggle,
  onSelect,
  style,
}: NavigatorRowProps) {
  const translate = useT();
  const canToggle = node.children.length > 0;
  const ref = navigatorRef(node);
  const className = [
    styles.row,
    styles[node.kind],
    styles[node.status],
    isSelected ? styles.selected : "",
    isActive ? styles.active : "",
    isVisible ? "" : styles.hiddenRow,
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
    if (event.key === "ArrowRight" && canToggle && !isExpanded) {
      event.preventDefault();
      onToggle?.(node.id);
    } else if (event.key === "ArrowLeft" && canToggle && isExpanded) {
      event.preventDefault();
      onToggle?.(node.id);
    }
  }

  return (
    <div
      aria-expanded={canToggle ? isExpanded : undefined}
      aria-label={labelFor(node, translate)}
      aria-level={node.depth + 1}
      aria-selected={isSelected}
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
      style={{ ...style, paddingInlineStart: indentFor(node.depth) }}
    >
      <span className={styles.indent} aria-hidden="true" />
      <button
        aria-label={canToggle ? (isExpanded ? translate("nav.collapse") : translate("nav.expand")) : undefined}
        className={styles.disclosure}
        disabled={!canToggle}
        onClick={(event) => {
          stop(event);
          if (canToggle) onToggle?.(node.id);
        }}
        tabIndex={-1}
        type="button"
      >
        {canToggle ? (isExpanded ? <ChevronDown aria-hidden="true" size={13} /> : <ChevronRight aria-hidden="true" size={13} />) : <span className={styles.disclosureSpacer} />}
      </button>
      <span className={`${styles.statusDot} ${styles[`status${node.status}`]}`} title={translate(`status.${node.status}` as const)} aria-label={translate(`status.${node.status}` as const)} role="img" />
      <span className={styles.nodeIcon}><IconForNode isExpanded={isExpanded} node={node} /></span>
      <span className={styles.nodeMain}>
        <span className={styles.nodeName}>{node.name}</span>
        {node.kind === "agent" ? <AgentSubline node={node} translate={translate} /> : null}
      </span>
      {!isVisible && node.kind === "project" ? <EyeOff aria-label={translate("nav.hidden")} className={styles.visibilityIcon} size={12} /> : null}
      {node.kind === "agent" ? <AgentBadges node={node} translate={translate} /> : null}
      <span className={styles.nodeCount}>{countLabel(node, translate)}</span>
      <span className={styles.actions} onClick={(event) => event.stopPropagation()}>{rowActions(node, actions, translate)}</span>
    </div>
  );
}
