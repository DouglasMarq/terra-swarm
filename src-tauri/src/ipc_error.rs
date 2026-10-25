use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IpcErrorCode {
    ChangedOnDisk,
    Busy,
    Other,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct IpcError {
    pub code: IpcErrorCode,
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
    fn given_a_coded_error_when_serializing_then_it_has_its_code_in_camel_case_and_its_message() {
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
    fn given_a_plain_message_when_converting_then_it_gets_the_other_code() {
        let error = IpcError::from("terminal t-1 not found".to_string());
        assert_eq!(error.code, IpcErrorCode::Other);
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            json!({ "code": "other", "message": "terminal t-1 not found" })
        );
    }
}
