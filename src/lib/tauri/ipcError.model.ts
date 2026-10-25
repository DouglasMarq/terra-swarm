/** Failures a command tells apart by code (`IpcErrorCode` in `src-tauri/src/ipc_error.rs`). */
export type IpcErrorCode = "changedOnDisk" | "busy" | "other";

/** What `write_workspace_file` and `write_terminal` reject with, instead of a plain message. */
export interface IpcErrorPayload {
  code: IpcErrorCode;
  /** Short English message the UI can show. */
  message: string;
}
