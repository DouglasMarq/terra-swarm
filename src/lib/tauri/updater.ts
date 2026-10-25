import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

export type { Update };

export type UpdateCheckResult =
  | { kind: "update"; version: string; current: string; update: Update }
  | { kind: "none" }
  | { kind: "error" };

export function appVersion(): Promise<string> {
  return getVersion();
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    if (!update) return { kind: "none" };
    const current = await getVersion();
    return { kind: "update", version: update.version, current, update };
  } catch (err) {
    console.error("update check failed:", err);
    return { kind: "error" };
  }
}

export async function installUpdate(update: Update | null): Promise<void> {
  if (!update) return;
  await update.downloadAndInstall();
  await relaunch();
}
