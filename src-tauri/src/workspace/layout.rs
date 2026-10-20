//! Containers, panes and tabs inside a workspace.

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
            last_used_at: Some(unix_millis()),
            size: 0.0,
            internal_layout: default_layout_mode(),
            collapsed: false,
            active_pane_id: None,
            visible: true,
            closed: false,
            fullscreen: false,
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
        // A legacy workspace has no container records. Creating the first
        // deterministic record is safe and keeps existing PTYs untouched.
        if workspace.containers.is_empty() {
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

    /// Place a terminal in a visual pane and sub-tab without touching the
    /// PTY manager. Existing duplicate references are removed first, then a
    /// normalized pane/tab pair is created or updated.
    pub fn set_terminal_placement(
        &mut self,
        workspace_id: &str,
        terminal_id: &str,
        pane_id: String,
        tab_id: String,
    ) -> Result<(), String> {
        let pane_id = pane_id.trim().to_string();
        let tab_id = tab_id.trim().to_string();
        if pane_id.is_empty() || tab_id.is_empty() {
            return Err("pane id and tab id cannot be empty".to_string());
        }
        let workspace = self.workspace_mut(workspace_id)?;
        let terminal = workspace
            .terminals
            .iter_mut()
            .find(|terminal| terminal.id == terminal_id)
            .ok_or_else(|| {
                format!(
                    "terminal {} not found in workspace {}",
                    terminal_id, workspace_id
                )
            })?;
        let command = terminal.command.clone();
        let suspended = terminal.suspended;
        terminal.pane_id = Some(pane_id.clone());
        terminal.tab_id = Some(tab_id.clone());

        // One terminal/tab identity can have only one visual location. This
        // also cleans stale references left by interrupted UI reorders.
        let mut displaced_tabs: Vec<(Option<String>, String)> = Vec::new();
        for pane in &mut workspace.panes {
            pane.tabs.retain(|tab| {
                let displaced = tab.pty_id.as_deref() != Some(terminal_id)
                    && tab.id.as_str() == tab_id.as_str();
                let remove = tab.pty_id.as_deref() == Some(terminal_id) || displaced;
                if remove {
                    displaced_tabs.push((tab.pty_id.clone(), tab.id.clone()));
                }
                !remove
            });
            if pane.active_tab_id.as_deref() == Some(tab_id.as_str()) {
                pane.active_tab_id = pane.tabs.first().map(|tab| tab.id.clone());
            }
        }
        for other_terminal in &mut workspace.terminals {
            if other_terminal.id == terminal_id {
                continue;
            }
            if displaced_tabs.iter().any(|(pty_id, displaced_tab_id)| {
                pty_id.as_deref() == Some(other_terminal.id.as_str())
                    || other_terminal.tab_id.as_deref() == Some(displaced_tab_id.as_str())
            }) {
                other_terminal.pane_id = None;
                other_terminal.tab_id = None;
            }
        }

        let pane_index =
            if let Some(index) = workspace.panes.iter().position(|pane| pane.id == pane_id) {
                index
            } else {
                workspace.panes.push(Pane {
                    id: pane_id.clone(),
                    name: if command.trim().is_empty() {
                        "Terminal".to_string()
                    } else {
                        command.clone()
                    },
                    cwd: workspace.cwd.clone(),
                    tabs: Vec::new(),
                    active_tab_id: None,
                    kind: Some("terminal".to_string()),
                    disabled: false,
                    collapsed: false,
                    width: None,
                    height: None,
                    container_id: None,
                    layout: None,
                });
                workspace.panes.len() - 1
            };
        let container_id = workspace.panes[pane_index]
            .container_id
            .clone()
            .or_else(|| {
                workspace
                    .containers
                    .first()
                    .map(|container| container.id.clone())
            })
            .unwrap_or_else(|| Self::default_container_id(workspace_id));
        let container_index = Self::ensure_container(workspace, &container_id)?;
        if workspace.panes[pane_index].container_id.is_none() {
            workspace.panes[pane_index].container_id = Some(container_id.clone());
        }
        if !workspace.containers[container_index]
            .pane_ids
            .iter()
            .any(|id| id == &pane_id)
        {
            workspace.containers[container_index]
                .pane_ids
                .push(pane_id.clone());
        }
        let pane = &mut workspace.panes[pane_index];
        if let Some(tab) = pane.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.kind = if tab.kind.trim().is_empty() {
                default_tab_kind()
            } else {
                tab.kind.clone()
            };
            tab.name = if tab.name.trim().is_empty() {
                command.clone()
            } else {
                tab.name.clone()
            };
            tab.cwd = workspace.cwd.clone();
            tab.pty_id = Some(terminal_id.to_string());
            tab.suspended = suspended;
        } else {
            pane.tabs.push(TerminalTab {
                id: tab_id.clone(),
                kind: default_tab_kind(),
                name: if command.trim().is_empty() {
                    "Terminal".to_string()
                } else {
                    command.clone()
                },
                cwd: workspace.cwd.clone(),
                pty_id: Some(terminal_id.to_string()),
                session_id: None,
                last_used_at: Some(unix_millis()),
                completion_unread: false,
                extra_args: Vec::new(),
                suspended,
            });
        }
        pane.active_tab_id = Some(tab_id);
        self.save();
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
        self.save();
        Ok(())
    }

    /// Reorder visual containers without touching panes or PTYs. Unknown and
    /// duplicate ids are ignored, and omitted existing containers retain their
    /// relative order for forward-compatible clients.
    pub fn reorder_containers(
        &mut self,
        workspace_id: &str,
        order: &[String],
    ) -> Result<(), String> {
        let workspace = self.workspace_mut(workspace_id)?;
        let mut remaining = std::mem::take(&mut workspace.containers);
        let mut sorted = Vec::with_capacity(remaining.len());
        for id in order {
            if let Some(index) = remaining.iter().position(|container| &container.id == id) {
                sorted.push(remaining.remove(index));
            }
        }
        sorted.extend(remaining);
        workspace.containers = sorted;
        self.save();
        Ok(())
    }

    /// Reorder pane ids inside one container. The pane records themselves are
    /// not deleted or recreated, preserving tab and PTY identity.
    pub fn reorder_panes(
        &mut self,
        workspace_id: &str,
        container_id: &str,
        order: &[String],
    ) -> Result<(), String> {
        let workspace = self.workspace_mut(workspace_id)?;
        let container_index = match Self::container_index(workspace, container_id) {
            Some(index) => index,
            None if workspace.containers.is_empty() => {
                Self::ensure_container(workspace, container_id)?
            }
            None => {
                return Err(format!(
                    "container {} not found in workspace {}",
                    container_id, workspace_id
                ));
            }
        };
        let container = &mut workspace.containers[container_index];
        let mut remaining = std::mem::take(&mut container.pane_ids);
        let mut sorted = Vec::with_capacity(remaining.len());
        for id in order {
            if let Some(index) = remaining.iter().position(|pane_id| pane_id == id) {
                sorted.push(remaining.remove(index));
            }
        }
        sorted.extend(remaining);
        container.pane_ids = sorted;
        if let Some(layout) = &mut container.layout {
            layout.item_ids = container.pane_ids.clone();
        }
        self.save();
        Ok(())
    }

    /// Move an existing pane between visual containers. A pane move is pure
    /// metadata: every terminal tab and its PTY remain untouched.
    pub fn move_pane(
        &mut self,
        workspace_id: &str,
        pane_id: &str,
        to_container_id: &str,
        index: Option<usize>,
    ) -> Result<(), String> {
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
        self.save();
        Ok(())
    }

    /// Apply a partial container state update. Visible/closed are kept
    /// complementary when only one side is supplied, and invalid active pane
    /// ids are rejected rather than persisted as dangling selections.
    pub fn set_container_state(
        &mut self,
        workspace_id: &str,
        container_id: &str,
        patch: WorkspaceContainerPatch,
    ) -> Result<(), String> {
        let workspace = self.workspace_mut(workspace_id)?;
        let container_index = match Self::container_index(workspace, container_id) {
            Some(index) => index,
            None if workspace.containers.is_empty() => {
                Self::ensure_container(workspace, container_id)?
            }
            None => {
                return Err(format!(
                    "container {} not found in workspace {}",
                    container_id, workspace_id
                ));
            }
        };
        let valid_panes = workspace.containers[container_index]
            .pane_ids
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        if let Some(active_pane_id) = patch.active_pane_id.as_deref() {
            if !valid_panes.contains(active_pane_id) {
                return Err(format!(
                    "pane {} is not in container {}",
                    active_pane_id, container_id
                ));
            }
        }
        let container = &mut workspace.containers[container_index];
        if let Some(visible) = patch.visible {
            container.visible = visible;
            if patch.closed.is_none() {
                container.closed = !visible;
            }
        }
        if let Some(closed) = patch.closed {
            container.closed = closed;
            if patch.visible.is_none() {
                container.visible = !closed;
            }
        }
        if let Some(collapsed) = patch.collapsed {
            container.collapsed = collapsed;
        }
        if let Some(fullscreen) = patch.fullscreen {
            container.fullscreen = fullscreen;
        }
        if patch.clear_active_pane {
            container.active_pane_id = None;
        } else if let Some(active_pane_id) = patch.active_pane_id {
            container.active_pane_id = Some(active_pane_id);
        }
        if let Some(internal_layout) = patch.internal_layout {
            let internal_layout = internal_layout.trim();
            if !internal_layout.is_empty() {
                container.internal_layout = internal_layout.to_string();
            }
        }
        if let Some(size) = patch.size.filter(|size| size.is_finite()) {
            container.size = size.clamp(0.0, 100.0);
        }
        if let Some(mut layout) = patch.layout {
            normalize_layout_state(&mut layout);
            layout.item_ids.retain(|id| valid_panes.contains(id));
            container.layout = Some(layout);
        }
        self.save();
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
        self.save();
        Ok(())
    }

    pub fn set_collapsed(&mut self, workspace_id: &str, collapsed: bool) -> Result<(), String> {
        let workspace = self.workspace_mut(workspace_id)?;
        workspace.collapsed = collapsed;
        self.save();
        Ok(())
    }
}
