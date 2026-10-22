/**
 * The failure's own message: an `Error`'s message or a thrown string (IPC
 * commands reject with one). Without either, `fallback`, or the value as text.
 */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback ?? String(error);
}
