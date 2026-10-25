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

export function PreviewPanel({ workspaceId }: PreviewPanelProps) {
  const translate = useT();
  const detected = usePreviewStore((state) => (workspaceId ? state.detected[workspaceId] ?? EMPTY : EMPTY));
  const selected = usePreviewStore((state) => (workspaceId ? state.selected[workspaceId] ?? null : null));
  const isProbing = usePreviewStore((state) => state.isProbing);
  const mcpPort = useMcpStore((state) => state.server?.port ?? null);
  const [draft, setDraft] = useState(selected ?? "");
  const [isInvalid, setInvalid] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const probed = useRef<Set<string>>(new Set());

  useEffect(() => setDraft(selected ?? ""), [selected]);

  useEffect(() => {
    if (!workspaceId || detected.length > 0 || probed.current.has(workspaceId)) return;
    probed.current.add(workspaceId);
    void usePreviewStore.getState().probe(workspaceId, mcpPort);
  }, [workspaceId, detected.length, mcpPort]);

  if (!workspaceId) {
    return (
      <div className="terra-preview-empty">
        <Globe size={18} aria-hidden="true" />
        <span>{translate("preview.noWorkspace")}</span>
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
          placeholder={translate("preview.placeholder")}
          aria-label={translate("preview.address")}
          aria-invalid={isInvalid}
          spellCheck={false}
        />
        <datalist id={`terra-preview-urls-${workspaceId}`}>
          {detected.map((url) => (
            <option key={url} value={url} />
          ))}
        </datalist>
        <button type="button" className="terra-preview-icon" onClick={() => setReloadKey((key) => key + 1)} disabled={!selected} aria-label={translate("preview.reload")} title={translate("preview.reload")}>
          <RotateCw size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="terra-preview-icon"
          onClick={() => void usePreviewStore.getState().probe(workspaceId, mcpPort)}
          disabled={isProbing}
          aria-label={translate("preview.scan")}
          title={translate("preview.scan")}
        >
          <Radar size={13} aria-hidden="true" />
        </button>
      </form>
      {isInvalid ? <p className="terra-preview-hint" role="alert">{translate("preview.onlyLocal")}</p> : null}
      {selected ? (
        <iframe
          key={`${selected}#${reloadKey}`}
          className="terra-preview-frame"
          src={selected}
          title={translate("preview.frameTitle", { url: selected })}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="terra-preview-empty">
          <Globe size={18} aria-hidden="true" />
          <span>{isProbing ? translate("preview.scanning") : translate("preview.none")}</span>
        </div>
      )}
    </div>
  );
}
