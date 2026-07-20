import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

export type UpdateCheckResult =
  | { kind: "update"; version: string; current: string }
  | { kind: "none" }
  | { kind: "error" };

let pendingUpdate: Update | null = null;

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    if (!update) return { kind: "none" };
    pendingUpdate = update;
    const current = await getVersion();
    return { kind: "update", version: update.version, current };
  } catch (err) {
    console.error("update check failed:", err);
    return { kind: "error" };
  }
}

export async function installPendingUpdate(): Promise<void> {
  if (!pendingUpdate) return;
  await pendingUpdate.downloadAndInstall();
  await relaunch();
}
