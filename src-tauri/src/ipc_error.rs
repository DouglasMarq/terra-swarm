//! The error a Tauri command rejects with when the UI must tell one failure
//! from another. Most commands reject with a plain message (`Result<T, String>`);
//! a command returning `IpcError` rejects with `{ "code": ..., "message": ... }`,
//! which `src/lib/tauri/errors.ts` turns into an error the UI matches by code
//! instead of by message text.

use serde::Serialize;

/// The failures the UI reacts to; anything else is `Other`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IpcErrorCode {
    /// The file changed on disk since the editor read it.
    ChangedOnDisk,
    /// The terminal's input queue is full; the write can be retried.
    Busy,
    Other,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct IpcError {
    pub code: IpcErrorCode,
    /// Short English message the UI can show.
    pub message: String,
}

impl IpcError {
    pub fn new(code: IpcErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Plain messages from module internals keep their text under `Other`.
impl From<String> for IpcError {
    fn from(message: String) -> Self {
        Self::new(IpcErrorCode::Other, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn given_a_coded_error_serializes_its_code_in_camel_case_and_its_message() {
        let error = IpcError::new(IpcErrorCode::ChangedOnDisk, "the file changed");
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            json!({ "code": "changedOnDisk", "message": "the file changed" })
        );
        assert_eq!(
            serde_json::to_value(IpcErrorCode::Busy).unwrap(),
            json!("busy")
        );
    }

    #[test]
    fn given_a_plain_message_converts_it_to_the_other_code() {
        let error = IpcError::from("terminal t-1 not found".to_string());
        assert_eq!(error.code, IpcErrorCode::Other);
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            json!({ "code": "other", "message": "terminal t-1 not found" })
        );
    }
}
