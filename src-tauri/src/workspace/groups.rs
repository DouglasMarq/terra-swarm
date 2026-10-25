//! Project groups: membership, rename, suspend and resume.

use super::*;
use std::sync::atomic::Ordering;

impl WorkspaceStore {
    /// Keep the workspace's group pointer and the group's project list as a
    /// bidirectional relationship. Passing `None` unassigns the workspace.
    pub fn set_workspace_group(
        &mut self,
        workspace_id: &str,
        group_id: Option<String>,
    ) -> Result<(), String> {
        let workspace_id = workspace_id.trim();
        if workspace_id.is_empty() {
            return Err("workspace id cannot be empty".to_string());
        }
        let group_id = group_id.and_then(|id| {
            let trimmed = id.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        self.workspace(workspace_id)?;
        if let Some(group_id) = group_id.as_deref() {
            if !self.groups.iter().any(|group| group.id == group_id) {
                return Err(format!("group {} not found", group_id));
            }
        }

        for group in &mut self.groups {
            group
                .project_ids
                .retain(|project_id| project_id != workspace_id);
        }
        if let Some(group_id) = group_id.as_deref() {
            let group = self.group_mut(group_id)?;
            if !group
                .project_ids
                .iter()
                .any(|project_id| project_id == workspace_id)
            {
                group.project_ids.push(workspace_id.to_string());
            }
        }
        let workspace = self.workspace_mut(workspace_id)?;
        workspace.group_id = group_id.clone();
        for terminal in &mut workspace.terminals {
            terminal.group_id = group_id.clone();
        }
        self.save();
        Ok(())
    }

    pub fn list_groups(&self) -> Vec<Group> {
        self.groups.clone()
    }

    pub fn create_group(&mut self, name: String) -> Group {
        let group = Group {
            id: format!("group-{}", NEXT_GROUP_ID.fetch_add(1, Ordering::SeqCst)),
            name: if name.trim().is_empty() {
                "group".to_string()
            } else {
                name.trim().to_string()
            },
            color: None,
            icon_url: None,
            collapsed: false,
            project_ids: Vec::new(),
            parent_group_id: None,
            layout_mode: Some(default_layout_mode()),
            suspended: false,
            archived: false,
            created_at: Some(crate::clock::now_epoch_millis()),
        };
        self.groups.push(group.clone());
        self.save();
        group
    }

    pub fn rename_group(&mut self, id: &str, name: String) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("group name cannot be empty".to_string());
        }
        let group = self.group_mut(id)?;
        group.name = name.to_string();
        self.save();
        Ok(())
    }

    /// Remove the group metadata but leave projects and terminals untouched.
    pub fn remove_group(&mut self, id: &str) -> Result<(), String> {
        let Some(index) = self.groups.iter().position(|group| group.id == id) else {
            return Err(format!("group {} not found", id));
        };
        self.groups.remove(index);
        for workspace in &mut self.workspaces {
            if workspace.group_id.as_deref() == Some(id) {
                workspace.group_id = None;
            }
            for terminal in &mut workspace.terminals {
                if terminal.group_id.as_deref() == Some(id) {
                    terminal.group_id = None;
                }
            }
        }
        self.save();
        Ok(())
    }

    /// Mark a group and its terminal metadata suspended, returning the PTY
    /// ids that the caller must stop. This method never touches processes.
    pub fn suspend_group(&mut self, id: &str) -> Result<Vec<String>, String> {
        let group = self.group_mut(id)?;
        group.suspended = true;
        let project_ids: std::collections::HashSet<String> =
            group.project_ids.iter().cloned().collect();
        let mut terminal_ids = Vec::new();
        for workspace in &mut self.workspaces {
            if workspace.group_id.as_deref() != Some(id) && !project_ids.contains(&workspace.id) {
                continue;
            }
            for terminal in &mut workspace.terminals {
                terminal.suspended = true;
                if !terminal_ids.iter().any(|id| id == &terminal.id) {
                    terminal_ids.push(terminal.id.clone());
                }
            }
            let suspended_ids: std::collections::HashSet<&str> =
                terminal_ids.iter().map(String::as_str).collect();
            for pane in &mut workspace.panes {
                for tab in &mut pane.tabs {
                    if tab
                        .pty_id
                        .as_deref()
                        .is_some_and(|pty_id| suspended_ids.contains(pty_id))
                    {
                        tab.suspended = true;
                    }
                }
            }
        }
        self.save();
        Ok(terminal_ids)
    }

    pub fn resume_group(&mut self, id: &str) -> Result<(), String> {
        let group = self.group_mut(id)?;
        group.suspended = false;
        self.save();
        Ok(())
    }
}
