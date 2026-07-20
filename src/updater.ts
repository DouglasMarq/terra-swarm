import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";

export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;

    const current = await getVersion();
    const yes = await ask(
      `A new version of Terra Swarm is available.\n\nCurrent: ${current}\nLatest: ${update.version}\n\nInstall now? The app will restart.`,
      { title: "Update available", kind: "info", okLabel: "Update", cancelLabel: "Later" },
    );
    if (!yes) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.error("update check failed:", err);
  }
}
