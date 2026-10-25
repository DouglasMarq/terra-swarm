use std::collections::HashMap;

use super::model::{AgentState, AgentStatus, StoreError, StoreResult};
use crate::clock::now_millis;

pub const MAX_STATUS_SUMMARY_CHARS: usize = 500;

#[derive(Default)]
pub struct StatusRegistry {
    by_terminal: HashMap<String, AgentStatus>,
}

impl StatusRegistry {
    pub fn report_status(
        &mut self,
        workspace_id: &str,
        terminal_id: &str,
        state: AgentState,
        summary: &str,
    ) -> StoreResult<AgentStatus> {
        let summary = summary.trim();
        if summary.chars().count() > MAX_STATUS_SUMMARY_CHARS {
            return Err(StoreError::Invalid(format!(
                "summary is longer than {} characters",
                MAX_STATUS_SUMMARY_CHARS
            )));
        }
        let status = AgentStatus {
            terminal_id: terminal_id.to_string(),
            workspace_id: workspace_id.to_string(),
            state,
            summary: summary.to_string(),
            updated_at: now_millis(),
        };
        self.by_terminal
            .insert(terminal_id.to_string(), status.clone());
        Ok(status)
    }

    pub fn status_of(&self, terminal_id: &str) -> Option<&AgentStatus> {
        self.by_terminal.get(terminal_id)
    }

    pub fn statuses(&self, workspace_id: &str) -> Vec<AgentStatus> {
        let mut list: Vec<AgentStatus> = self
            .by_terminal
            .values()
            .filter(|status| status.workspace_id == workspace_id)
            .cloned()
            .collect();
        list.sort_by(|a, b| a.terminal_id.cmp(&b.terminal_id));
        list
    }

    pub fn forget_status(&mut self, terminal_id: &str) {
        self.by_terminal.remove(terminal_id);
    }

    pub fn forget_workspace(&mut self, workspace_id: &str) {
        self.by_terminal
            .retain(|_, status| status.workspace_id != workspace_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_are_scoped_and_validated() {
        let mut registry = StatusRegistry::default();
        registry
            .report_status("ws-1", "t-1", AgentState::Working, "parsing")
            .unwrap();
        registry
            .report_status("ws-2", "t-5", AgentState::Idle, "")
            .unwrap();
        assert_eq!(registry.statuses("ws-1").len(), 1);
        assert!(registry
            .report_status("ws-1", "t-1", AgentState::Idle, &"x".repeat(501))
            .is_err());
        registry.forget_status("t-1");
        assert!(registry.statuses("ws-1").is_empty());
    }

    #[test]
    fn given_statuses_of_two_workspaces_when_forgetting_one_then_the_other_stays() {
        let mut registry = StatusRegistry::default();
        for workspace_id in ["ws-1", "ws-2"] {
            registry
                .report_status(
                    workspace_id,
                    &format!("{}-agent", workspace_id),
                    AgentState::Working,
                    "",
                )
                .unwrap();
        }

        registry.forget_workspace("ws-1");

        assert!(registry.statuses("ws-1").is_empty());
        assert_eq!(registry.statuses("ws-2").len(), 1);
    }
}
