use super::*;

impl WorkspaceStore {
    pub(crate) fn default_container_id(workspace_id: &str) -> String {
        format!("container-{}", workspace_id)
    }

    pub(crate) fn new_container(workspace_id: &str, id: String) -> WorkspaceContainer {
        WorkspaceContainer {
            id,
            project_id: workspace_id.to_string(),
            pane_ids: Vec::new(),
            last_used_at: Some(crate::clock::now_epoch_millis()),
            size: 0.0,
            internal_layout: default_layout_mode(),
            is_collapsed: false,
            active_pane_id: None,
            is_visible: true,
            is_closed: false,
            is_fullscreen: false,
            layout: Some(WorkspaceLayout::default()),
        }
    }

    pub(crate) fn container_index(workspace: &Workspace, container_id: &str) -> Option<usize> {
        workspace
            .containers
            .iter()
            .position(|container| container.id == container_id)
    }

    pub(crate) fn ensure_container(
        workspace: &mut Workspace,
        container_id: &str,
    ) -> Result<usize, String> {
        let container_id = container_id.trim();
        if container_id.is_empty() {
            return Err("container id cannot be empty".to_string());
        }
        if let Some(index) = Self::container_index(workspace, container_id) {
            return Ok(index);
        }
        let is_legacy_workspace = workspace.containers.is_empty();
        if is_legacy_workspace {
            workspace.containers.push(Self::new_container(
                workspace.id.as_str(),
                container_id.to_string(),
            ));
            return Ok(0);
        }
        Err(format!(
            "container {} not found in workspace {}",
            container_id, workspace.id
        ))
    }

    pub fn set_terminal_placement(
        &mut self,
        workspace_id: &str,
        placement: TerminalPlacement,
    ) -> Result<(), String> {
        let placement = placement.trimmed()?;
        let workspace = self.workspace_mut(workspace_id)?;
        let cwd = workspace.cwd.clone();
        let terminal = terminal_mut(workspace, &placement.terminal_id)?;
        let tab = placement.tab_for(terminal, cwd);
        let command = terminal.command.clone();
        terminal.pane_id = Some(placement.pane_id.clone());
        terminal.tab_id = Some(placement.tab_id.clone());
        remove_displaced(workspace, &placement);
        let pane_index = ensure_terminal_pane(workspace, &placement.pane_id, &command);
        attach_to_container(workspace, pane_index)?;
        place_tab(&mut workspace.panes[pane_index], tab);
        Ok(())
    }

    pub fn set_active_pane(
        &mut self,
        workspace_id: &str,
        pane_id: Option<String>,
    ) -> Result<(), String> {
        let workspace = self.workspace_mut(workspace_id)?;
        let pane_id = pane_id.and_then(|id| {
            let trimmed = id.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        if let Some(pane_id) = pane_id.as_deref() {
            if !workspace.panes.iter().any(|pane| pane.id == pane_id) {
                return Err(format!(
                    "pane {} not found in workspace {}",
                    pane_id, workspace_id
                ));
            }
        }
        workspace.active_pane_id = pane_id;
        workspace.active_container_id = workspace.active_pane_id.as_deref().and_then(|active_id| {
            workspace.containers.iter().find_map(|container| {
                container
                    .pane_ids
                    .iter()
                    .any(|pane_id| pane_id == active_id)
                    .then(|| container.id.clone())
            })
        });
        for container in &mut workspace.containers {
            if workspace.active_pane_id.is_none() {
                container.active_pane_id = None;
            } else if container
                .pane_ids
                .iter()
                .any(|id| Some(id.as_str()) == workspace.active_pane_id.as_deref())
            {
                container.active_pane_id = workspace.active_pane_id.clone();
            }
        }
        Ok(())
    }

    pub fn reorder_containers(
        &mut self,
        workspace_id: &str,
        order: &[String],
    ) -> Result<(), String> {
        let workspace = self.workspace_mut(workspace_id)?;
        let containers = std::mem::take(&mut workspace.containers);
        workspace.containers = reorder_by_ids(containers, order, |container| &container.id);
        Ok(())
    }

    pub fn reorder_panes(
        &mut self,
        workspace_id: &str,
        reorder: PaneReorder<'_>,
    ) -> Result<(), String> {
        let workspace = self.workspace_mut(workspace_id)?;
        let container_index = resolve_container(workspace, reorder.container_id)?;
        let container = &mut workspace.containers[container_index];
        let pane_ids = std::mem::take(&mut container.pane_ids);
        container.pane_ids = reorder_by_ids(pane_ids, reorder.order, String::as_str);
        if let Some(layout) = &mut container.layout {
            layout.item_ids = container.pane_ids.clone();
        }
        Ok(())
    }

    pub fn move_pane(&mut self, workspace_id: &str, pane_move: PaneMove) -> Result<(), String> {
        let PaneMove {
            pane_id,
            to_container_id,
            index,
        } = pane_move;
        let pane_id = pane_id.as_str();
        let to_container_id = to_container_id.as_str();
        let workspace = self.workspace_mut(workspace_id)?;
        if !workspace.panes.iter().any(|pane| pane.id == pane_id) {
            return Err(format!(
                "pane {} not found in workspace {}",
                pane_id, workspace_id
            ));
        }
        let target_index = Self::container_index(workspace, to_container_id).ok_or_else(|| {
            format!(
                "container {} not found in workspace {}",
                to_container_id, workspace_id
            )
        })?;
        for container in &mut workspace.containers {
            container.pane_ids.retain(|id| id != pane_id);
            if container.active_pane_id.as_deref() == Some(pane_id)
                && container.id != to_container_id
            {
                container.active_pane_id = container.pane_ids.first().cloned();
            }
        }
        let target = &mut workspace.containers[target_index];
        let insertion = index
            .unwrap_or(target.pane_ids.len())
            .min(target.pane_ids.len());
        target.pane_ids.insert(insertion, pane_id.to_string());
        target
            .active_pane_id
            .get_or_insert_with(|| pane_id.to_string());
        if let Some(layout) = &mut target.layout {
            layout.item_ids = target.pane_ids.clone();
        }
        if let Some(pane) = workspace.panes.iter_mut().find(|pane| pane.id == pane_id) {
            pane.container_id = Some(to_container_id.to_string());
        }
        Ok(())
    }

    pub fn set_container_state(
        &mut self,
        workspace_id: &str,
        change: ContainerStateChange<'_>,
    ) -> Result<(), String> {
        let ContainerStateChange {
            container_id,
            patch,
        } = change;
        let workspace = self.workspace_mut(workspace_id)?;
        let container_index = resolve_container(workspace, container_id)?;
        let container = &mut workspace.containers[container_index];
        let unknown_active_pane = patch
            .active_pane_id
            .as_deref()
            .filter(|active| !container.pane_ids.iter().any(|id| id == active));
        if let Some(active_pane_id) = unknown_active_pane {
            return Err(format!(
                "pane {} is not in container {}",
                active_pane_id, container_id
            ));
        }
        apply_container_patch(container, patch);
        Ok(())
    }

    pub fn set_layout(
        &mut self,
        workspace_id: &str,
        mut layout: WorkspaceLayout,
    ) -> Result<(), String> {
        let workspace = self.workspace_mut(workspace_id)?;
        normalize_layout_state(&mut layout);
        workspace.layout_mode = Some(layout.mode.clone());
        workspace.layout = Some(layout);
        Ok(())
    }

    pub fn set_collapsed(&mut self, workspace_id: &str, is_collapsed: bool) -> Result<(), String> {
        let workspace = self.workspace_mut(workspace_id)?;
        workspace.is_collapsed = is_collapsed;
        Ok(())
    }
}

const DEFAULT_TERMINAL_NAME: &str = "Terminal";
const TERMINAL_PANE_KIND: &str = "terminal";

impl TerminalPlacement {
    fn trimmed(self) -> Result<Self, String> {
        let pane_id = self.pane_id.trim().to_string();
        let tab_id = self.tab_id.trim().to_string();
        if pane_id.is_empty() || tab_id.is_empty() {
            return Err("pane id and tab id cannot be empty".to_string());
        }
        Ok(Self {
            terminal_id: self.terminal_id,
            pane_id,
            tab_id,
        })
    }

    fn is_displacing(&self, tab: &TerminalTab) -> bool {
        tab.pty_id.as_deref() == Some(self.terminal_id.as_str()) || tab.id == self.tab_id
    }

    fn tab_for(&self, terminal: &TerminalMeta, cwd: String) -> TerminalTab {
        TerminalTab {
            id: self.tab_id.clone(),
            kind: default_tab_kind(),
            name: display_name(&terminal.command),
            cwd,
            pty_id: Some(self.terminal_id.clone()),
            session_id: None,
            last_used_at: Some(crate::clock::now_epoch_millis()),
            has_unread_completion: false,
            extra_args: Vec::new(),
            is_suspended: terminal.is_suspended,
        }
    }
}

struct DisplacedTab {
    pty_id: Option<String>,
    id: String,
}

fn display_name(command: &str) -> String {
    if command.trim().is_empty() {
        return DEFAULT_TERMINAL_NAME.to_string();
    }
    command.to_string()
}

fn terminal_mut<'a>(
    workspace: &'a mut Workspace,
    terminal_id: &str,
) -> Result<&'a mut TerminalMeta, String> {
    workspace
        .terminals
        .iter_mut()
        .find(|terminal| terminal.id == terminal_id)
        .ok_or_else(|| {
            format!(
                "terminal {} not found in workspace {}",
                terminal_id, workspace.id
            )
        })
}

fn remove_displaced(workspace: &mut Workspace, placement: &TerminalPlacement) {
    let displaced = displaced_tabs(&workspace.panes, placement);
    for pane in &mut workspace.panes {
        remove_displaced_tabs(pane, placement);
    }
    for terminal in &mut workspace.terminals {
        if terminal.id != placement.terminal_id && is_displaced(terminal, &displaced) {
            terminal.pane_id = None;
            terminal.tab_id = None;
        }
    }
}

fn displaced_tabs(panes: &[Pane], placement: &TerminalPlacement) -> Vec<DisplacedTab> {
    panes
        .iter()
        .flat_map(|pane| &pane.tabs)
        .filter(|tab| placement.is_displacing(tab))
        .map(|tab| DisplacedTab {
            pty_id: tab.pty_id.clone(),
            id: tab.id.clone(),
        })
        .collect()
}

fn remove_displaced_tabs(pane: &mut Pane, placement: &TerminalPlacement) {
    pane.tabs.retain(|tab| !placement.is_displacing(tab));
    if pane.active_tab_id.as_deref() == Some(placement.tab_id.as_str()) {
        pane.active_tab_id = pane.tabs.first().map(|tab| tab.id.clone());
    }
}

fn is_displaced(terminal: &TerminalMeta, displaced: &[DisplacedTab]) -> bool {
    displaced.iter().any(|tab| {
        tab.pty_id.as_deref() == Some(terminal.id.as_str())
            || terminal.tab_id.as_deref() == Some(tab.id.as_str())
    })
}

fn ensure_terminal_pane(workspace: &mut Workspace, pane_id: &str, command: &str) -> usize {
    if let Some(index) = workspace.panes.iter().position(|pane| pane.id == pane_id) {
        return index;
    }
    workspace.panes.push(Pane {
        id: pane_id.to_string(),
        name: display_name(command),
        cwd: workspace.cwd.clone(),
        tabs: Vec::new(),
        active_tab_id: None,
        kind: Some(TERMINAL_PANE_KIND.to_string()),
        is_disabled: false,
        is_collapsed: false,
        width: None,
        height: None,
        container_id: None,
        layout: None,
    });
    workspace.panes.len() - 1
}

fn attach_to_container(workspace: &mut Workspace, pane_index: usize) -> Result<(), String> {
    let container_id = pane_container_id(workspace, pane_index);
    let container_index = WorkspaceStore::ensure_container(workspace, &container_id)?;
    let pane = &mut workspace.panes[pane_index];
    pane.container_id.get_or_insert(container_id);
    let pane_ids = &mut workspace.containers[container_index].pane_ids;
    if !pane_ids.contains(&pane.id) {
        pane_ids.push(pane.id.clone());
    }
    Ok(())
}

fn pane_container_id(workspace: &Workspace, pane_index: usize) -> String {
    workspace.panes[pane_index]
        .container_id
        .clone()
        .or_else(|| {
            workspace
                .containers
                .first()
                .map(|container| container.id.clone())
        })
        .unwrap_or_else(|| WorkspaceStore::default_container_id(&workspace.id))
}

fn place_tab(pane: &mut Pane, tab: TerminalTab) {
    pane.active_tab_id = Some(tab.id.clone());
    pane.tabs.push(tab);
}

fn resolve_container(workspace: &mut Workspace, container_id: &str) -> Result<usize, String> {
    if let Some(index) = WorkspaceStore::container_index(workspace, container_id) {
        return Ok(index);
    }
    if workspace.containers.is_empty() {
        return WorkspaceStore::ensure_container(workspace, container_id);
    }
    Err(format!(
        "container {} not found in workspace {}",
        container_id, workspace.id
    ))
}

fn apply_container_patch(container: &mut WorkspaceContainer, patch: WorkspaceContainerPatch) {
    apply_visibility(container, patch.is_visible, patch.is_closed);
    if let Some(is_collapsed) = patch.is_collapsed {
        container.is_collapsed = is_collapsed;
    }
    if let Some(is_fullscreen) = patch.is_fullscreen {
        container.is_fullscreen = is_fullscreen;
    }
    if patch.should_clear_active_pane {
        container.active_pane_id = None;
    } else if let Some(active_pane_id) = patch.active_pane_id {
        container.active_pane_id = Some(active_pane_id);
    }
    if let Some(internal_layout) = patch.internal_layout {
        apply_internal_layout(container, &internal_layout);
    }
    if let Some(size) = patch.size.filter(|size| size.is_finite()) {
        container.size = size.clamp(MIN_CONTAINER_SIZE_PERCENT, MAX_CONTAINER_SIZE_PERCENT);
    }
    if let Some(layout) = patch.layout {
        apply_layout(container, layout);
    }
}

fn apply_visibility(
    container: &mut WorkspaceContainer,
    is_visible: Option<bool>,
    is_closed: Option<bool>,
) {
    if let Some(is_visible) = is_visible {
        container.is_visible = is_visible;
        if is_closed.is_none() {
            container.is_closed = !is_visible;
        }
    }
    if let Some(is_closed) = is_closed {
        container.is_closed = is_closed;
        if is_visible.is_none() {
            container.is_visible = !is_closed;
        }
    }
}

fn apply_internal_layout(container: &mut WorkspaceContainer, internal_layout: &str) {
    let internal_layout = internal_layout.trim();
    if !internal_layout.is_empty() {
        container.internal_layout = internal_layout.to_string();
    }
}

fn apply_layout(container: &mut WorkspaceContainer, mut layout: WorkspaceLayout) {
    normalize_layout_state(&mut layout);
    let valid_panes = container
        .pane_ids
        .iter()
        .collect::<std::collections::HashSet<_>>();
    layout.item_ids.retain(|id| valid_panes.contains(id));
    container.layout = Some(layout);
}
