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
