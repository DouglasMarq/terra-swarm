export type IpcErrorCode = "changedOnDisk" | "busy" | "other";

export interface IpcErrorPayload {
  code: IpcErrorCode;
  message: string;
}
