import { useEffect, useMemo, useState } from "react";
import { Plus, Send, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { sendPromptToTerminal } from "../../app/sendPromptToTerminal";
import { fillPrompt } from "../../domain/prompts";
import { useLibraryStore } from "../../stores/libraryStore";
import { DialogFooter, TerraDialog } from "../overlays/Dialog";
import { Button } from "../ui/Button";
import "./library.css";

const MAX_PROMPT_TITLE_CHARS = 80;

export interface PromptTarget {
  id: string;
  label: string;
}

export interface PromptLibraryDialogProps {
  projectName: string | null;
  /** Running agents of the active project. */
  targets: readonly PromptTarget[];
  /** Pre-selected target: the orchestrator or the focused agent. */
  defaultTargetId: string | null;
}

/** Saved prompts: edit them, and send one to an agent of the project. */
export function PromptLibraryDialog({ projectName, targets, defaultTargetId }: PromptLibraryDialogProps) {
  const t = useT();
  const open = useLibraryStore((state) => state.dialog === "prompts");
  const prompts = useLibraryStore((state) => state.prompts);
  const { closeDialog, savePrompt, deletePrompt } = useLibraryStore.getState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = prompts.find((prompt) => prompt.id === selectedId) ?? null;
  const dirty = selected ? selected.title !== title || selected.body !== body : Boolean(title.trim() || body.trim());

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    setQuery("");
    setTargetId(defaultTargetId ?? targets[0]?.id ?? null);
    const first = useLibraryStore.getState().prompts[0] ?? null;
    setSelectedId(first?.id ?? null);
    setTitle(first?.title ?? "");
    setBody(first?.body ?? "");
  }, [open, defaultTargetId, targets]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? prompts.filter((prompt) => `${prompt.title}\n${prompt.body}`.toLocaleLowerCase().includes(needle))
      : prompts;
  }, [prompts, query]);

  const pick = (id: string | null) => {
    const prompt = prompts.find((candidate) => candidate.id === id) ?? null;
    setSelectedId(prompt?.id ?? null);
    setTitle(prompt?.title ?? "");
    setBody(prompt?.body ?? "");
    setNotice(null);
  };

  const save = () => {
    if (!body.trim()) return;
    const saved = savePrompt({ id: selectedId ?? undefined, title, body });
    setSelectedId(saved.id);
    setTitle(saved.title);
    setNotice(t("library.saved"));
  };

  const send = async () => {
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target || !body.trim()) return;
    try {
      await sendPromptToTerminal(target.id, fillPrompt(body, { project: projectName }));
      setNotice(t("library.sent", { agent: target.label }));
    } catch {
      setNotice(t("library.sendFailed", { agent: target.label }));
    }
  };

  return (
    <TerraDialog
      className="terra-library"
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
      title={t("library.title")}
      description={t("library.description")}
    >
      <div className="terra-library-body">
        <aside className="terra-library-list">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("library.search")} aria-label={t("library.search")} />
          <ul>
            {visible.map((prompt) => (
              <li key={prompt.id}>
                <button type="button" data-active={prompt.id === selectedId} onClick={() => pick(prompt.id)}>
                  {prompt.title}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="terra-library-new" onClick={() => pick(null)}>
            <Plus size={13} aria-hidden="true" /> {t("library.new")}
          </button>
        </aside>
        <div className="terra-library-editor">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("library.titlePlaceholder")} aria-label={t("library.titleLabel")} maxLength={MAX_PROMPT_TITLE_CHARS} />
          <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={t("library.bodyPlaceholder")} aria-label={t("library.bodyLabel")} />
          <p className="terra-library-hint">{t("library.placeholderHint")}</p>
        </div>
      </div>
      {notice ? <p className="terra-library-notice" role="status">{notice}</p> : null}
      <DialogFooter>
        {selected ? (
          <Button type="button" variant="ghost" onClick={() => { deletePrompt(selected.id); pick(null); }}>
            <Trash2 size={14} aria-hidden="true" /> {t("library.delete")}
          </Button>
        ) : null}
        <Button type="button" onClick={save} disabled={!dirty || !body.trim()}>
          {t("library.save")}
        </Button>
        <select
          className="terra-library-target"
          value={targetId ?? ""}
          onChange={(event) => setTargetId(event.target.value || null)}
          aria-label={t("library.target")}
          disabled={targets.length === 0}
        >
          {targets.length === 0 ? <option value="">{t("library.noTargets")}</option> : null}
          {targets.map((target) => (
            <option key={target.id} value={target.id}>{target.label}</option>
          ))}
        </select>
        <Button type="button" variant="primary" onClick={() => void send()} disabled={!targetId || !body.trim()}>
          <Send size={14} aria-hidden="true" /> {t("library.send")}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
