import type { IpcErrorCode, IpcErrorPayload } from "./ipcError.model";

const IPC_ERROR_CODES: readonly string[] = ["changedOnDisk", "busy", "other"] satisfies readonly IpcErrorCode[];

/** A command failure the UI tells apart by `code`; `message` is the backend's text. */
export class IpcError extends Error {
  readonly code: IpcErrorCode;
  /** The value the command rejected with. */
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

/** A coded command rejection as an {@link IpcError}; any other value is returned unchanged. */
export function toIpcError(error: unknown): unknown {
  return isIpcErrorPayload(error) ? new IpcError(error, error) : error;
}

/** Whether `error` is a command failure with `code`. */
export function isIpcError(error: unknown, code: IpcErrorCode): error is IpcError {
  return error instanceof IpcError && error.code === code;
}
