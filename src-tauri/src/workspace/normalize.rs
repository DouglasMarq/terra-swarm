//! Normalization of loaded workspace data before it reaches the UI or PTYs.

use super::*;

impl WorkspaceStore {
    /// Drops malformed entries and clamps out-of-range values, so a
    /// hand-edited or corrupted store can never panic or break the layout.
    pub(crate) fn validate(&mut self) -> bool {
        let before_workspaces = self.workspaces.clone();
        let before_groups = self.groups.clone();
        let mut seen_ws = std::collections::HashSet::new();
        self.workspaces.retain_mut(|w| {
            let id = w.id.trim();
            if id.is_empty() {
                return false;
            }
            if id.len() != w.id.len() {
                w.id = id.to_string();
            }
            seen_ws.insert(w.id.clone())
        });
        // Terminal ids are the durable PTY/scrollback identity.  They must be
        // unique across the whole store, not merely inside one workspace:
        // every PTY command addresses an id without a workspace qualifier.
        // Keep the first occurrence in deterministic workspace/terminal order
        // and quarantine later occurrences from the normalized metadata.
        let mut seen_terminal_ids = std::collections::HashSet::new();
        for w in &mut self.workspaces {
            let mut duplicate_terminal_ids = std::collections::HashSet::new();
            w.terminals.retain_mut(|t| {
                let id = t.id.trim();
                if id.is_empty() {
                    return false;
                }
                if id.len() != t.id.len() {
                    t.id = id.to_string();
                }
                if seen_terminal_ids.insert(t.id.clone()) {
                    true
                } else {
                    duplicate_terminal_ids.insert(t.id.clone());
                    false
                }
            });
            for t in &mut w.terminals {
                t.width = t
                    .width
                    .filter(|v| v.is_finite())
                    .map(|v| v.clamp(MIN_TERMINAL_WIDTH, MAX_TERMINAL_WIDTH));
                if let Some(Err(error)) = t.worktree.as_ref().map(|info| info.check()) {
                    eprintln!("dropping the worktree of terminal {}: {}", t.id, error);
                    t.worktree = None;
                }
            }
            let workspace_terminal_ids = w
                .terminals
                .iter()
                .map(|terminal| terminal.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            w.panes.retain_mut(|pane| {
                let id = pane.id.trim();
                if id.is_empty() {
                    return false;
                }
                if id.len() != pane.id.len() {
                    pane.id = id.to_string();
                }
                pane.tabs.retain_mut(|tab| {
                    let tab_id = tab.id.trim();
                    if tab_id.is_empty() {
                        return false;
                    }
                    if tab_id.len() != tab.id.len() {
                        tab.id = tab_id.to_string();
                    }
                    // A pane tab that points at a duplicate or at a terminal
                    // removed during recovery would otherwise make a later
                    // PTY operation ambiguous. Tabs without a PTY are kept as
                    // visual/orphan metadata for the frontend to reconcile.
                    if let Some(pty_id) = tab.pty_id.as_deref() {
                        if duplicate_terminal_ids.contains(pty_id)
                            || !workspace_terminal_ids.contains(pty_id)
                        {
                            return false;
                        }
                    }
                    true
                });
                if pane
                    .active_tab_id
                    .as_deref()
                    .is_some_and(|id| !pane.tabs.iter().any(|tab| tab.id == id))
                {
                    pane.active_tab_id = pane.tabs.first().map(|tab| tab.id.clone());
                }
                pane.width = pane.width.filter(|v| v.is_finite() && *v >= 0.0);
                pane.height = pane.height.filter(|v| v.is_finite() && *v >= 0.0);
                if let Some(layout) = &mut pane.layout {
                    normalize_layout_state(layout);
                    let valid_tabs = pane
                        .tabs
                        .iter()
                        .map(|tab| tab.id.as_str())
                        .collect::<std::collections::HashSet<_>>();
                    layout
                        .item_ids
                        .retain(|id| valid_tabs.contains(id.as_str()));
                }
                true
            });
            w.containers.retain_mut(|container| {
                let id = container.project_id.trim();
                if id.is_empty() {
                    return false;
                }
                if id.len() != container.project_id.len() {
                    container.project_id = id.to_string();
                }
                container.size = if container.size.is_finite() {
                    container.size.max(0.0)
                } else {
                    0.0
                };
                container
                    .pane_ids
                    .retain(|pane_id| !pane_id.trim().is_empty());
                if let Some(layout) = &mut container.layout {
                    normalize_layout_state(layout);
                }
                true
            });
            let mut seen_container_ids = std::collections::HashSet::new();
            let workspace_id_for_containers = w.id.clone();
            for (index, container) in w.containers.iter_mut().enumerate() {
                let base = if container.id.trim().is_empty() {
                    if index == 0 {
                        format!("container-{}", workspace_id_for_containers)
                    } else {
                        format!("container-{}-{}", workspace_id_for_containers, index + 1)
                    }
                } else {
                    container.id.trim().to_string()
                };
                let mut candidate = base.clone();
                let mut suffix = 2;
                while !seen_container_ids.insert(candidate.clone()) {
                    candidate = format!("{}-{}", base, suffix);
                    suffix += 1;
                }
                container.id = candidate;
                container.size = container
                    .size
                    .clamp(MIN_CONTAINER_SIZE_PERCENT, MAX_CONTAINER_SIZE_PERCENT);
                let valid_panes = container
                    .pane_ids
                    .iter()
                    .map(String::as_str)
                    .collect::<std::collections::HashSet<_>>();
                if let Some(active) = container.active_pane_id.as_deref() {
                    if !valid_panes.contains(active) {
                        container.active_pane_id = None;
                    }
                }
                if let Some(layout) = &mut container.layout {
                    layout
                        .item_ids
                        .retain(|id| valid_panes.contains(id.as_str()));
                }
            }
            let container_ids = w
                .containers
                .iter()
                .map(|container| container.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            for pane in &mut w.panes {
                if pane
                    .container_id
                    .as_deref()
                    .is_some_and(|container_id| !container_ids.contains(container_id))
                {
                    pane.container_id = None;
                }
            }
            if let Some(layout) = &mut w.layout {
                normalize_layout_state(layout);
                layout.item_ids.retain(|id| {
                    container_ids.contains(id.as_str()) || w.panes.iter().any(|pane| pane.id == *id)
                });
            }
            if w.active_container_id
                .as_deref()
                .is_some_and(|id| !container_ids.contains(id))
            {
                w.active_container_id = None;
            }
            let pane_ids = w
                .panes
                .iter()
                .map(|pane| pane.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            if w.active_pane_id
                .as_deref()
                .is_some_and(|id| !pane_ids.contains(id))
            {
                w.active_pane_id = None;
            }
            if let Some(layout) = &mut w.layout {
                layout.item_ids.retain(|id| {
                    container_ids.contains(id.as_str()) || pane_ids.contains(id.as_str())
                });
            }
        }
        let mut seen_groups = std::collections::HashSet::new();
        self.groups.retain_mut(|group| {
            let id = group.id.trim();
            let name = group.name.trim();
            if id.is_empty() || name.is_empty() || !seen_groups.insert(id.to_string()) {
                return false;
            }
            if id.len() != group.id.len() {
                group.id = id.to_string();
            }
            if name.len() != group.name.len() {
                group.name = name.to_string();
            }
            let mut seen_projects = std::collections::HashSet::new();
            group.project_ids.retain_mut(|project_id| {
                let project_id_trimmed = project_id.trim();
                if project_id_trimmed.is_empty()
                    || !seen_projects.insert(project_id_trimmed.to_string())
                {
                    return false;
                }
                if project_id_trimmed.len() != project_id.len() {
                    *project_id = project_id_trimmed.to_string();
                }
                true
            });
            true
        });
        self.workspaces != before_workspaces || self.groups != before_groups
    }
}
