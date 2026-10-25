import { useEffect, useRef, useState, type FormEvent } from "react";
import { Globe, Radar, RotateCw } from "lucide-react";
import { useT } from "../../i18n";
import { useMcpStore } from "../../stores/mcpStore";
import { loopbackUrl, usePreviewStore } from "../../stores/previewStore";
import "./preview.css";

export interface PreviewPanelProps {
  workspaceId: string | null;
}

const EMPTY: readonly string[] = [];

/**
 * The project's local dev server, side by side with its agents. URLs come
 * from what the terminals print and from probing common ports; only pages
 * on this machine (localhost) load here.
 */
export function PreviewPanel({ workspaceId }: PreviewPanelProps) {
  const t = useT();
  const detected = usePreviewStore((state) => (workspaceId ? state.detected[workspaceId] ?? EMPTY : EMPTY));
  const selected = usePreviewStore((state) => (workspaceId ? state.selected[workspaceId] ?? null : null));
  const probing = usePreviewStore((state) => state.probing);
  const mcpPort = useMcpStore((state) => state.server?.port ?? null);
  const [draft, setDraft] = useState(selected ?? "");
  const [invalid, setInvalid] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const probed = useRef<Set<string>>(new Set());

  useEffect(() => setDraft(selected ?? ""), [selected]);

  // Probe once per project when nothing has been printed yet.
  useEffect(() => {
    if (!workspaceId || detected.length > 0 || probed.current.has(workspaceId)) return;
    probed.current.add(workspaceId);
    void usePreviewStore.getState().probe(workspaceId, mcpPort);
  }, [workspaceId, detected.length, mcpPort]);

  if (!workspaceId) {
    return (
      <div className="terra-preview-empty">
        <Globe size={18} aria-hidden="true" />
        <span>{t("preview.noWorkspace")}</span>
      </div>
    );
  }

  const go = (event: FormEvent) => {
    event.preventDefault();
    const url = loopbackUrl(draft);
    setInvalid(!url);
    if (!url) return;
    usePreviewStore.getState().select(workspaceId, url);
    setReloadKey((key) => key + 1);
  };

  return (
    <div className="terra-preview">
      <form className="terra-preview-bar" onSubmit={go}>
        <input
          list={`terra-preview-urls-${workspaceId}`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          placeholder={t("preview.placeholder")}
          aria-label={t("preview.address")}
          aria-invalid={invalid}
          spellCheck={false}
        />
        <datalist id={`terra-preview-urls-${workspaceId}`}>
          {detected.map((url) => (
            <option key={url} value={url} />
          ))}
        </datalist>
        <button type="button" className="terra-preview-icon" onClick={() => setReloadKey((key) => key + 1)} disabled={!selected} aria-label={t("preview.reload")} title={t("preview.reload")}>
          <RotateCw size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="terra-preview-icon"
          onClick={() => void usePreviewStore.getState().probe(workspaceId, mcpPort)}
          disabled={probing}
          aria-label={t("preview.scan")}
          title={t("preview.scan")}
        >
          <Radar size={13} aria-hidden="true" />
        </button>
      </form>
      {invalid ? <p className="terra-preview-hint" role="alert">{t("preview.onlyLocal")}</p> : null}
      {selected ? (
        <iframe
          key={`${selected}#${reloadKey}`}
          className="terra-preview-frame"
          src={selected}
          title={t("preview.frameTitle", { url: selected })}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="terra-preview-empty">
          <Globe size={18} aria-hidden="true" />
          <span>{probing ? t("preview.scanning") : t("preview.none")}</span>
        </div>
      )}
    </div>
  );
}
