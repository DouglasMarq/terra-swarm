import { useCallback, useEffect, useRef, useState } from "react";
import { appVersion as readAppVersion, checkForUpdate, installUpdate as installAppUpdate, type Update, type UpdateCheckResult } from "../lib/tauri/updater";
import { translateNow } from "../i18n";
import { MS_PER_HOUR } from "../lib/time/durations";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";

const UPDATE_CHECK_MS = MS_PER_HOUR;

export type UpdateCheckState = "idle" | "checking" | "uptodate" | "error";

export function useUpdater() {
  const [appVersion, setAppVersion] = useState("");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [isUpdateInstalling, setUpdateInstalling] = useState(false);
  const [updateCheckState, setUpdateCheckState] = useState<UpdateCheckState>("idle");
  const notifyUpdateAvailable = useTerminalRuntimeStore((state) => state.notifyUpdateAvailable);
  const pendingUpdate = useRef<Update | null>(null);

  useEffect(() => {
    readAppVersion()
      .then(setAppVersion)
      .catch((error) => console.warn("could not read the app version:", error));
  }, []);

  const handleUpdateAvailable = useCallback((result: Extract<UpdateCheckResult, { kind: "update" }>) => {
    pendingUpdate.current = result.update;
    setUpdateVersion(result.version);
    notifyUpdateAvailable(result.version, result.current);
  }, [notifyUpdateAvailable]);

  const runUpdateCheck = useCallback(() => {
    void checkForUpdate()
      .then((result) => {
        if (result.kind === "update") handleUpdateAvailable(result);
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
          handleUpdateAvailable(result);
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
    if (isUpdateInstalling) return;
    setUpdateInstalling(true);
    installAppUpdate(pendingUpdate.current).catch((error) => {
      console.error("update install failed:", error);
      setUpdateInstalling(false);
      useTerminalRuntimeStore.getState().pushSystemNotification(translateNow("app.updateFailed"));
    });
  };

  return { appVersion, updateVersion, isUpdateInstalling, updateCheckState, manualUpdateCheck, installUpdate };
}
