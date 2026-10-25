use super::*;
use crate::sync::LockExt;
use std::sync::Mutex;

pub(crate) fn change_and_save<T>(
    store: &Mutex<WorkspaceStore>,
    change: impl FnOnce(&mut WorkspaceStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut store = store.lock_or_recover();
    let value = change(&mut store)?;
    store.save();
    Ok(value)
}

impl WorkspaceStore {
    /// Returns false when the workspace no longer exists (e.g. it was closed
    /// while a terminal was being spawned), so the caller can roll back.
    pub fn add_terminal(&mut self, ws_id: &str, meta: TerminalMeta) -> bool {
        if !self.can_add_terminal(ws_id, &meta.id) {
            return false;
        }
        self.record_terminal(ws_id, meta);
        self.save();
        true
    }

    pub fn remove_terminal(&mut self, terminal_id: &str) {
        self.forget_terminal(terminal_id);
        self.save();
    }
}
