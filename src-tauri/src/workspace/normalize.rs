//! Normalization of loaded workspace data before it reaches the UI or PTYs.

use super::*;
use std::collections::HashSet;

const FIRST_DUPLICATE_SUFFIX: u32 = 2;

impl WorkspaceStore {
    /// Drops malformed entries and clamps out-of-range values, so a
    /// hand-edited or corrupted store can never panic or break the layout.
    pub(crate) fn normalize(&mut self) {
        normalize_workspace_ids(&mut self.workspaces);
        // Terminal ids are the durable PTY/scrollback identity.  They must be
        // unique across the whole store, not merely inside one workspace:
        // every PTY command addresses an id without a workspace qualifier.
        // Keep the first occurrence in deterministic workspace/terminal order
        // and quarantine later occurrences from the normalized metadata.
        let mut seen_terminal_ids = HashSet::new();
        for workspace in &mut self.workspaces {
            normalize_workspace(workspace, &mut seen_terminal_ids);
        }
        normalize_groups(&mut self.groups);
    }

    pub(crate) fn is_normalized(&self) -> bool {
        let mut normalized = WorkspaceStore {
            workspaces: self.workspaces.clone(),
            groups: self.groups.clone(),
            save_path: None,
        };
        normalized.normalize();
        normalized.workspaces == self.workspaces && normalized.groups == self.groups
    }
}

struct KnownTerminals<'a> {
    ids: HashSet<&'a str>,
    duplicates: &'a HashSet<String>,
}

impl KnownTerminals<'_> {
    fn allows(&self, tab: &TerminalTab) -> bool {
        tab.pty_id
            .as_deref()
            .is_none_or(|pty_id| !self.duplicates.contains(pty_id) && self.ids.contains(pty_id))
    }
}

fn normalize_workspace_ids(workspaces: &mut Vec<Workspace>) {
    let mut seen = HashSet::new();
    workspaces.retain_mut(|workspace| {
        trim_in_place(&mut workspace.id);
        !workspace.id.is_empty() && seen.insert(workspace.id.clone())
    });
}

fn normalize_workspace(workspace: &mut Workspace, seen_terminal_ids: &mut HashSet<String>) {
    workspace.terminals.retain_mut(|terminal| {
        trim_in_place(&mut terminal.id);
        !terminal.id.is_empty()
    });
    let duplicates = duplicate_terminal_ids(&workspace.terminals, seen_terminal_ids);
    workspace
        .terminals
        .retain(|terminal| seen_terminal_ids.insert(terminal.id.clone()));
    workspace.terminals.iter_mut().for_each(normalize_terminal);
    normalize_panes(workspace, &duplicates);
    normalize_containers(workspace);
    normalize_selection(workspace);
}

fn duplicate_terminal_ids(
    terminals: &[TerminalMeta],
    seen_terminal_ids: &HashSet<String>,
) -> HashSet<String> {
    let mut counted = HashSet::new();
    terminals
        .iter()
        .filter(|terminal| {
            seen_terminal_ids.contains(&terminal.id) || !counted.insert(terminal.id.as_str())
        })
        .map(|terminal| terminal.id.clone())
        .collect()
}

fn normalize_terminal(terminal: &mut TerminalMeta) {
    terminal.width = terminal
        .width
        .filter(|width| width.is_finite())
        .map(|width| width.clamp(MIN_TERMINAL_WIDTH, MAX_TERMINAL_WIDTH));
    if let Some(Err(error)) = terminal.worktree.as_ref().map(|info| info.check()) {
        eprintln!(
            "dropping the worktree of terminal {}: {}",
            terminal.id, error
        );
        terminal.worktree = None;
    }
}

fn normalize_panes(workspace: &mut Workspace, duplicates: &HashSet<String>) {
    let known = KnownTerminals {
        ids: workspace
            .terminals
            .iter()
            .map(|terminal| terminal.id.as_str())
            .collect(),
        duplicates,
    };
    workspace.panes.retain_mut(|pane| {
        trim_in_place(&mut pane.id);
        if pane.id.is_empty() {
            return false;
        }
        normalize_pane(pane, &known);
        true
    });
}

fn normalize_pane(pane: &mut Pane, known: &KnownTerminals) {
    // A pane tab that points at a duplicate or at a terminal removed during
    // recovery would otherwise make a later PTY operation ambiguous. Tabs
    // without a PTY are kept as visual/orphan metadata for the frontend to
    // reconcile.
    pane.tabs.retain_mut(|tab| {
        trim_in_place(&mut tab.id);
        !tab.id.is_empty() && known.allows(tab)
    });
    pane.repair_active_tab();
    pane.width = pane
        .width
        .filter(|value| value.is_finite() && *value >= 0.0);
    pane.height = pane
        .height
        .filter(|value| value.is_finite() && *value >= 0.0);
    let Some(layout) = &mut pane.layout else {
        return;
    };
    normalize_layout_state(layout);
    let valid_tabs = pane
        .tabs
        .iter()
        .map(|tab| tab.id.as_str())
        .collect::<HashSet<_>>();
    layout
        .item_ids
        .retain(|id| valid_tabs.contains(id.as_str()));
}

fn normalize_containers(workspace: &mut Workspace) {
    workspace.containers.retain_mut(|container| {
        trim_in_place(&mut container.project_id);
        !container.project_id.is_empty()
    });
    assign_container_ids(workspace);
    workspace
        .containers
        .iter_mut()
        .for_each(normalize_container);
}

fn assign_container_ids(workspace: &mut Workspace) {
    let mut taken = HashSet::new();
    for (index, container) in workspace.containers.iter_mut().enumerate() {
        let base = container_base_id(&workspace.id, index, &container.id);
        container.id = first_free_id(&base, &taken);
        taken.insert(container.id.clone());
    }
}

fn container_base_id(workspace_id: &str, index: usize, id: &str) -> String {
    let id = id.trim();
    if !id.is_empty() {
        return id.to_string();
    }
    if index == 0 {
        return WorkspaceStore::default_container_id(workspace_id);
    }
    let position = index + 1;
    format!("container-{}-{}", workspace_id, position)
}

fn first_free_id(base: &str, taken: &HashSet<String>) -> String {
    let mut candidate = base.to_string();
    let mut suffix = FIRST_DUPLICATE_SUFFIX;
    while taken.contains(&candidate) {
        candidate = format!("{}-{}", base, suffix);
        suffix += 1;
    }
    candidate
}

fn normalize_container(container: &mut WorkspaceContainer) {
    container.size = if container.size.is_finite() {
        container
            .size
            .clamp(MIN_CONTAINER_SIZE_PERCENT, MAX_CONTAINER_SIZE_PERCENT)
    } else {
        MIN_CONTAINER_SIZE_PERCENT
    };
    container
        .pane_ids
        .retain(|pane_id| !pane_id.trim().is_empty());
    let valid_panes = container
        .pane_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if container
        .active_pane_id
        .as_deref()
        .is_some_and(|active| !valid_panes.contains(active))
    {
        container.active_pane_id = None;
    }
    let Some(layout) = &mut container.layout else {
        return;
    };
    normalize_layout_state(layout);
    layout
        .item_ids
        .retain(|id| valid_panes.contains(id.as_str()));
}

fn normalize_selection(workspace: &mut Workspace) {
    let container_ids = workspace
        .containers
        .iter()
        .map(|container| container.id.as_str())
        .collect::<HashSet<_>>();
    for pane in &mut workspace.panes {
        if pane
            .container_id
            .as_deref()
            .is_some_and(|container_id| !container_ids.contains(container_id))
        {
            pane.container_id = None;
        }
    }
    let pane_ids = workspace
        .panes
        .iter()
        .map(|pane| pane.id.as_str())
        .collect::<HashSet<_>>();
    if let Some(layout) = &mut workspace.layout {
        normalize_layout_state(layout);
        layout
            .item_ids
            .retain(|id| container_ids.contains(id.as_str()) || pane_ids.contains(id.as_str()));
    }
    if workspace
        .active_container_id
        .as_deref()
        .is_some_and(|id| !container_ids.contains(id))
    {
        workspace.active_container_id = None;
    }
    if workspace
        .active_pane_id
        .as_deref()
        .is_some_and(|id| !pane_ids.contains(id))
    {
        workspace.active_pane_id = None;
    }
}

fn normalize_groups(groups: &mut Vec<Group>) {
    let mut seen = HashSet::new();
    groups.retain_mut(|group| {
        trim_in_place(&mut group.id);
        trim_in_place(&mut group.name);
        if group.id.is_empty() || group.name.is_empty() || !seen.insert(group.id.clone()) {
            return false;
        }
        normalize_project_ids(&mut group.project_ids);
        true
    });
}

fn normalize_project_ids(project_ids: &mut Vec<String>) {
    let mut seen = HashSet::new();
    project_ids.retain_mut(|project_id| {
        trim_in_place(project_id);
        !project_id.is_empty() && seen.insert(project_id.clone())
    });
}
