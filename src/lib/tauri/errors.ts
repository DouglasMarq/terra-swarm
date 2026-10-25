import type { IpcErrorCode, IpcErrorPayload } from "./ipcError.model";

const IPC_ERROR_CODES: readonly string[] = ["changedOnDisk", "busy", "other"] satisfies readonly IpcErrorCode[];

export class IpcError extends Error {
  readonly code: IpcErrorCode;
  readonly cause: unknown;

  constructor(payload: IpcErrorPayload, cause: unknown = payload) {
    super(payload.message);
    this.name = "IpcError";
    this.code = payload.code;
    this.cause = cause;
  }
}

function isIpcErrorPayload(value: unknown): value is IpcErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const { code, message } = value as Record<string, unknown>;
  return typeof code === "string" && IPC_ERROR_CODES.includes(code) && typeof message === "string";
}

export function toIpcError(error: unknown): unknown {
  return isIpcErrorPayload(error) ? new IpcError(error, error) : error;
}

export function isIpcError(error: unknown, code: IpcErrorCode): error is IpcError {
  return error instanceof IpcError && error.code === code;
}
