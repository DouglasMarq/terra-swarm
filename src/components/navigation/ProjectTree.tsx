import { Folder, Plus } from "../../components/icons";
import type { ReactNode } from "react";
import { AgentNode } from "./AgentNode";
import { GroupNode } from "./GroupNode";
import { NavigatorNodeRow } from "./NavigatorNodeRow";
import { ProjectNode } from "./ProjectNode";
import type { DropIntent } from "./types";
import type {
  NavigatorAgentNode,
  NavigatorContainerNode,
  NavigatorGroupNode,
  NavigatorNode,
  NavigatorNodeActions,
  NavigatorPanelProps,
  NavigatorPaneNode,
  NavigatorProjectNode,
  NavigatorTree,
} from "./types";
import styles from "./Navigator.module.css";

export interface ProjectTreeViewProps extends Omit<NavigatorPanelProps, "className" | "style" | "title" | "emptyState" | "activeActivity" | "onActivityChange" | "onCreateGroup"> {
  tree: NavigatorTree;
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onCreateGroup?: () => void;
  dropIntents?: Readonly<Record<string, DropIntent | undefined>>;
}

function nodeSelected(node: NavigatorNode, props: ProjectTreeViewProps): boolean {
  return node.kind === "project"
    ? node.workspaceId === props.activeWorkspaceId
    : node.kind === "container"
      ? node.containerId === props.activeContainerId
      : node.kind === "pane"
        ? node.paneId === props.activePaneId
    : node.kind === "agent" && node.terminalId === props.activeTerminalId;
}

function nodeActive(node: NavigatorNode, props: ProjectTreeViewProps): boolean {
  return node.kind === "project"
    ? node.workspaceId === props.activeWorkspaceId
    : node.kind === "container"
      ? node.containerId === props.activeContainerId
      : node.kind === "pane"
        ? node.paneId === props.activePaneId
    : node.kind === "agent" && node.terminalId === props.activeTerminalId;
}

function actionSet(props: ProjectTreeViewProps): NavigatorNodeActions {
  const hide = props.onHideContainer ?? props.onHideWorkspace;
  return {
    onOpen: (ref) => {
      if (ref.kind === "project") {
        props.onOpenWorkspace?.(ref.id);
      } else if (ref.kind === "container" || ref.kind === "pane") {
        const node = props.tree.byId[ref.id];
        if (node?.kind === ref.kind) props.onOpenWorkspace?.(node.projectId);
      } else if (ref.kind === "agent") {
        const agent = props.tree.byId[ref.id]?.kind === "agent" ? props.tree.byId[ref.id] : null;
        if (agent && agent.kind === "agent") {
          props.onOpenTerminal?.(agent.workspaceId, agent.terminalId);
          props.onFocus?.(agent.terminalId);
        }
      }
    },
    onCreate: (ref) => {
      if (ref.kind === "group") {
        (props.onCreateProject ?? props.onCreateWorkspace)?.(ref.id);
      } else if (ref.kind === "project") {
        props.onCreateAgent?.(ref.id);
      }
    },
    onRename: props.onRenameNode,
    onHide: (ref) => {
      if (ref.kind === "project") hide?.(ref.id);
    },
    onSuspend: (ref) => {
      if (ref.kind === "group") props.onSuspendGroup?.(ref.id);
    },
    onResume: (ref) => {
      if (ref.kind === "group") props.onResumeGroup?.(ref.id);
    },
    onContextMenu: props.onContextMenu,
  };
}

function renderNode(node: NavigatorNode, props: ProjectTreeViewProps, actions: NavigatorNodeActions): ReactNode {
  const expanded = props.expandedIds.has(node.id);
  const common = {
    active: nodeActive(node, props),
    dragEnabled: Boolean(props.onMoveNode),
    dropIntent: props.dropIntents?.[node.id] ?? null,
    expanded,
    selected: nodeSelected(node, props),
    visible: node.kind === "project" ? node.visible : true,
  };
  let row: ReactNode;
  if (node.kind === "group") {
    row = <GroupNode {...common} actions={actions} node={node as NavigatorGroupNode} onToggle={props.onToggle} />;
  } else if (node.kind === "project") {
    row = <ProjectNode {...common} actions={actions} node={node as NavigatorProjectNode} onToggle={props.onToggle} />;
  } else if (node.kind === "container") {
    row = <NavigatorNodeRow {...common} actions={actions} node={node as NavigatorContainerNode} onToggle={props.onToggle} />;
  } else if (node.kind === "pane") {
    row = <NavigatorNodeRow {...common} actions={actions} node={node as NavigatorPaneNode} onToggle={props.onToggle} />;
  } else {
    row = <AgentNode {...common} actions={actions} node={node as NavigatorAgentNode} />;
  }
  return (
    <div key={`${node.kind}:${node.id}`}>
      {row}
      {expanded && node.children.length > 0 ? node.children.map((child) => renderNode(child, props, actions)) : null}
    </div>
  );
}

/** Tree renderer kept separate so the panel can own DnD lifecycle and headers. */
export function ProjectTree({ tree, expandedIds, onToggle, onCreateGroup, dropIntents, ...props }: ProjectTreeViewProps) {
  const viewProps: ProjectTreeViewProps = { tree, expandedIds, onToggle, onCreateGroup, dropIntents, ...props };
  const actions = actionSet(viewProps);
  const groups = tree.roots.filter((node): node is NavigatorGroupNode => node.kind === "group");
  const ungrouped = tree.roots.filter((node): node is NavigatorProjectNode => node.kind === "project");
  const hasAny = groups.length > 0 || ungrouped.length > 0;
  return (
    <div aria-label="Projetos Terra" className={styles.tree} role="tree">
      {groups.length > 0 || onCreateGroup ? (
        <div className={styles.sectionHeader}>
          <span className={styles.sectionHeaderText}><Folder aria-hidden="true" size={12} /> Grupos <span className={styles.sectionCount}>{groups.length}</span></span>
          {onCreateGroup ? <button aria-label="Criar grupo" className={`${styles.createButton} ${styles.sectionCreate}`} onClick={onCreateGroup} type="button"><Plus aria-hidden="true" size={13} /></button> : null}
        </div>
      ) : null}
      {groups.map((group) => renderNode(group, viewProps, actions))}
      {ungrouped.length > 0 || groups.length === 0 ? (
        <div className={styles.sectionHeader}>
          <span className={styles.sectionHeaderText}><Folder aria-hidden="true" size={12} /> Sem grupo <span className={styles.sectionCount}>{ungrouped.length}</span></span>
        </div>
      ) : null}
      {ungrouped.map((project) => renderNode(project, viewProps, actions))}
      {!hasAny ? <div className={styles.emptyState}><div><strong>Nenhum projeto encontrado</strong>Crie um projeto ou ajuste a busca.</div></div> : null}
    </div>
  );
}
