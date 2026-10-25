use super::*;
use std::sync::atomic::Ordering;

impl WorkspaceStore {
    pub(crate) fn workspace(&self, id: &str) -> Result<&Workspace, String> {
        self.get(id)
            .ok_or_else(|| format!("workspace {} not found", id))
    }

    pub(crate) fn workspace_mut(&mut self, id: &str) -> Result<&mut Workspace, String> {
        self.workspaces
            .iter_mut()
            .find(|workspace| workspace.id == id)
            .ok_or_else(|| format!("workspace {} not found", id))
    }

    pub(crate) fn group_mut(&mut self, id: &str) -> Result<&mut Group, String> {
        self.groups
            .iter_mut()
            .find(|group| group.id == id)
            .ok_or_else(|| format!("group {} not found", id))
    }

    pub fn create(&mut self, name: String, cwd: String) -> Workspace {
        let cwd = if cwd.trim().is_empty() {
            home_dir()
        } else {
            cwd
        };
        let id = format!("ws-{}", NEXT_WS_ID.fetch_add(1, Ordering::SeqCst));
        let ws = Workspace {
            id: id.clone(),
            name: if name.trim().is_empty() {
                "workspace".into()
            } else {
                name
            },
            cwd,
            terminals: Vec::new(),
            group_id: None,
            panes: Vec::new(),
            containers: vec![Self::new_container(&id, Self::default_container_id(&id))],
            active_pane_id: None,
            active_container_id: None,
            collapsed: false,
            archived: false,
            created_at: Some(crate::clock::now_epoch_millis()),
            layout_mode: Some(default_layout_mode()),
            layout: Some(WorkspaceLayout::default()),
        };
        self.workspaces.push(ws.clone());
        ws
    }

    pub fn remove(&mut self, id: &str) -> Option<Workspace> {
        let idx = self.workspaces.iter().position(|w| w.id == id)?;
        let ws = self.workspaces.remove(idx);
        for group in &mut self.groups {
            group.project_ids.retain(|project_id| project_id != id);
        }
        Some(ws)
    }

    pub fn get(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == id)
    }

    pub fn terminal_owner(&self, terminal_id: &str) -> Option<&str> {
        self.workspaces.iter().find_map(|workspace| {
            workspace
                .terminals
                .iter()
                .any(|terminal| terminal.id == terminal_id)
                .then_some(workspace.id.as_str())
        })
    }

    pub fn can_add_terminal(&self, ws_id: &str, terminal_id: &str) -> bool {
        self.get(ws_id).is_some()
            && self
                .terminal_owner(terminal_id)
                .is_none_or(|owner| owner == ws_id)
    }

    pub fn record_terminal(&mut self, ws_id: &str, meta: TerminalMeta) {
        let Ok(ws) = self.workspace_mut(ws_id) else {
            return;
        };
        match ws.terminals.iter_mut().find(|t| t.id == meta.id) {
            Some(existing) => refresh_terminal(existing, meta),
            None => ws.terminals.push(meta),
        }
    }

    pub fn forget_terminal(&mut self, terminal_id: &str) {
        for ws in self.workspaces.iter_mut() {
            ws.terminals.retain(|t| t.id != terminal_id);
            for pane in &mut ws.panes {
                pane.tabs.retain(|tab| {
                    tab.pty_id.as_deref() != Some(terminal_id) && tab.id.as_str() != terminal_id
                });
                pane.repair_active_tab();
            }
        }
    }

    pub fn rename(&mut self, id: &str, name: String) -> Result<(), String> {
        let name = name.trim().to_string();
        let ws = self.workspace_mut(id)?;
        if name.is_empty() {
            return Ok(());
        }
        ws.name = name;
        Ok(())
    }

    pub fn reorder_workspaces(&mut self, order: &[String]) {
        let workspaces = std::mem::take(&mut self.workspaces);
        self.workspaces = reorder_by_ids(workspaces, order, |workspace| &workspace.id);
    }

    pub fn set_width(&mut self, ws_id: &str, terminal_id: &str, width: f64) -> Result<(), String> {
        let ws = self.workspace_mut(ws_id)?;
        let t = ws
            .terminals
            .iter_mut()
            .find(|t| t.id == terminal_id)
            .ok_or_else(|| format!("terminal {} not found in workspace {}", terminal_id, ws_id))?;
        t.width = width
            .is_finite()
            .then_some(width.clamp(MIN_TERMINAL_WIDTH, MAX_TERMINAL_WIDTH));
        Ok(())
    }
}

fn refresh_terminal(existing: &mut TerminalMeta, meta: TerminalMeta) {
    existing.command = meta.command;
    existing.suspended = false;
    if meta.worktree.is_some() {
        existing.worktree = meta.worktree;
    }
    if meta.role.is_some() {
        existing.role = meta.role;
    }
}
