import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate, installPendingUpdate } from "../updater";
import { t } from "../i18n";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";

const UPDATE_CHECK_MS = 60 * 60 * 1000;

export type UpdateCheckState = "idle" | "checking" | "uptodate" | "error";

/** App version, the hourly update check and the manual check/install actions. */
export function useUpdater() {
  const [appVersion, setAppVersion] = useState("");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateCheckState, setUpdateCheckState] = useState<UpdateCheckState>("idle");
  const notifyUpdateAvailable = useTerminalRuntimeStore((state) => state.notifyUpdateAvailable);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch((error) => console.warn("could not read the app version:", error));
  }, []);

  const handleUpdateAvailable = useCallback((version: string, current: string) => {
    setUpdateVersion(version);
    notifyUpdateAvailable(version, current);
  }, [notifyUpdateAvailable]);

  const runUpdateCheck = useCallback(() => {
    void checkForUpdate()
      .then((result) => {
        if (result.kind === "update") handleUpdateAvailable(result.version, result.current);
      })
      .catch((error) => {
        console.warn("update check failed:", error);
      });
  }, [handleUpdateAvailable]);

  useEffect(() => {
    runUpdateCheck();
    const interval = window.setInterval(runUpdateCheck, UPDATE_CHECK_MS);
    return () => window.clearInterval(interval);
  }, [runUpdateCheck]);

  const manualUpdateCheck = () => {
    setUpdateCheckState("checking");
    checkForUpdate()
      .then((result) => {
        if (result.kind === "update") {
          handleUpdateAvailable(result.version, result.current);
          setUpdateCheckState("idle");
        } else {
          setUpdateCheckState(result.kind === "none" ? "uptodate" : "error");
        }
      })
      .catch((error) => {
        console.warn("manual update check failed:", error);
        setUpdateCheckState("error");
      });
  };

  const installUpdate = () => {
    if (updateInstalling) return;
    setUpdateInstalling(true);
    installPendingUpdate().catch((error) => {
      console.error("update install failed:", error);
      setUpdateInstalling(false);
      useTerminalRuntimeStore.getState().pushSystemNotification(t("app.updateFailed"));
    });
  };

  return { appVersion, updateVersion, updateInstalling, updateCheckState, manualUpdateCheck, installUpdate };
}
