import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, GitBranch, GitMerge, GitPullRequest, RefreshCw } from "lucide-react";
import { api } from "../../api";
import { useT } from "../../i18n";
import { useMcpStore } from "../../stores/mcpStore";
import { useReviewStore } from "../../stores/reviewStore";
import type { WorktreeDiff } from "../../types";
import { DialogFooter, TerraDialog } from "../overlays/Dialog";
import { Button } from "../ui/Button";
import { parsePatch, suggestTitle, type DiffFileSection } from "./diffModel";
import "./review.css";

type Busy = "load" | "commit" | "merge" | "pr" | null;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Review what an isolated agent changed on its branch, then commit it, merge
 * it into the base branch, or push it and open a pull request. Every action
 * here is one the user clicks for; nothing runs on its own.
 */
export function WorktreeReviewDialog() {
  const t = useT();
  const target = useReviewStore((state) => state.target);
  const close = useReviewStore((state) => state.close);
  const summary = useMcpStore((state) => (target ? state.statuses[target.terminalId]?.summary : undefined));
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!target) return;
    setBusy("load");
    setError(null);
    try {
      const next = await api.worktreeDiff(target.workspaceId, target.terminalId);
      setDiff(next);
      setSelected((current) => (current && next.files.some((file) => file.path === current) ? current : next.files[0]?.path ?? null));
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(null);
    }
  }, [target]);

  useEffect(() => {
    setDiff(null);
    setSelected(null);
    setNotice(null);
    setError(null);
    setConfirmMerge(false);
    setPrOpen(false);
    setPrUrl(null);
    if (!target) return;
    const title = suggestTitle(target.label, summary);
    setMessage(title);
    setPrTitle(title);
    setPrBody("");
    void load();
    // The summary seeds the drafts once, when the dialog opens.
  }, [target, load]);

  const sections = useMemo(() => parsePatch(diff?.patch ?? ""), [diff?.patch]);
  const section: DiffFileSection | undefined = sections.find((candidate) => candidate.path === selected);
  const status = diff?.status;
  const dirty = status ? status.dirty.length > 0 : false;
  const ahead = status?.ahead ?? 0;

  const run = async (kind: Exclude<Busy, "load" | null>, action: () => Promise<string | null>) => {
    if (!target) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const done = await action();
      if (done) setNotice(done);
      await load();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(null);
    }
  };

  const commit = () =>
    run("commit", async () => {
      await api.worktreeCommit(target!.workspaceId, target!.terminalId, message);
      return t("review.committed");
    });

  const merge = () => {
    if (!confirmMerge) {
      setConfirmMerge(true);
      return;
    }
    setConfirmMerge(false);
    void run("merge", async () => {
      await api.worktreeMerge(target!.workspaceId, target!.terminalId);
      return t("review.merged", { branch: status?.branch ?? "", base: status?.base ?? "" });
    });
  };

  const openPr = () =>
    run("pr", async () => {
      const url = await api.worktreeOpenPr(target!.workspaceId, target!.terminalId, prTitle, prBody);
      setPrUrl(url);
      setPrOpen(false);
      return t("review.prOpened");
    });

  const copyUrl = async () => {
    if (!prUrl) return;
    try {
      await navigator.clipboard.writeText(prUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <TerraDialog
      className="terra-review"
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t("review.title", { name: target?.label ?? "" })}
      description={
        status ? (
          <span className="terra-review-branch">
            <GitBranch size={12} aria-hidden="true" />
            {t("review.branchLine", { branch: status.branch, base: status.base })}
            <span className="terra-review-stat">{t("review.ahead", { count: status.ahead })}</span>
            {status.behind > 0 ? <span className="terra-review-stat">{t("review.behind", { count: status.behind })}</span> : null}
            {dirty ? <span className="terra-review-stat" data-tone="warn">{t("review.dirty", { count: status.dirty.length })}</span> : null}
          </span>
        ) : (
          t("review.loading")
        )
      }
    >
      <div className="terra-review-body">
        <nav className="terra-review-files" aria-label={t("review.files")}>
          <div className="terra-review-files-head">
            <span>{t("review.filesCount", { count: diff?.files.length ?? 0 })}</span>
            <button type="button" className="terra-review-icon" onClick={() => void load()} disabled={busy !== null} aria-label={t("review.refresh")} title={t("review.refresh")}>
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </div>
          {diff && diff.files.length === 0 ? <p className="terra-review-empty">{t("review.noChanges")}</p> : null}
          <ul>
            {diff?.files.map((file) => (
              <li key={file.path}>
                <button type="button" data-active={file.path === selected} onClick={() => setSelected(file.path)} title={file.path}>
                  <span className="terra-review-change" data-change={file.change}>{t(`review.change.${file.change}`)}</span>
                  <span className="terra-review-path">{file.path}</span>
                  {file.additions === null ? (
                    <span className="terra-review-counts">{t("review.binary")}</span>
                  ) : (
                    <span className="terra-review-counts">
                      <span data-kind="add">+{file.additions}</span> <span data-kind="del">−{file.deletions ?? 0}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="terra-review-diff" role="region" aria-label={t("review.diff")}>
          {diff?.truncated ? <p className="terra-review-empty">{t("review.truncated")}</p> : null}
          {section ? (
            section.binary ? (
              <p className="terra-review-empty">{t("review.binaryFile")}</p>
            ) : (
              <table>
                <tbody>
                  {section.lines.map((line, index) => (
                    <tr key={index} data-kind={line.kind}>
                      <td className="terra-review-num">{line.oldLine ?? ""}</td>
                      <td className="terra-review-num">{line.newLine ?? ""}</td>
                      <td className="terra-review-code">
                        <span aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                        {line.text}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : selected ? (
            <p className="terra-review-empty">{t("review.notInPatch")}</p>
          ) : null}
        </div>
      </div>

      {error ? <p className="terra-review-error" role="alert">{error}</p> : null}
      {notice ? <p className="terra-review-notice" role="status">{notice}</p> : null}
      {prUrl ? (
        <p className="terra-review-notice">
          <a href={prUrl} target="_blank" rel="noreferrer">{prUrl}</a>
          <button type="button" className="terra-review-icon" onClick={() => void copyUrl()} aria-label={t("review.copyUrl")} title={t("review.copyUrl")}>
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          </button>
        </p>
      ) : null}

      {dirty ? (
        <form
          className="terra-review-commit"
          onSubmit={(event) => {
            event.preventDefault();
            void commit();
          }}
        >
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={t("review.commitPlaceholder")}
            aria-label={t("review.commitMessage")}
            maxLength={300}
          />
          <Button type="submit" disabled={busy !== null || !message.trim()}>
            {busy === "commit" ? t("review.working") : t("review.commit")}
          </Button>
        </form>
      ) : null}

      {prOpen ? (
        <div className="terra-review-pr">
          <input value={prTitle} onChange={(event) => setPrTitle(event.target.value)} aria-label={t("review.prTitle")} placeholder={t("review.prTitle")} maxLength={200} />
          <textarea value={prBody} onChange={(event) => setPrBody(event.target.value)} aria-label={t("review.prBody")} placeholder={t("review.prBody")} rows={4} />
          <p className="terra-review-hint">{t("review.prHint", { branch: status?.branch ?? "", base: status?.base ?? "" })}</p>
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={close}>
          {t("common.close")}
        </Button>
        {prOpen ? (
          <Button type="button" onClick={() => void openPr()} disabled={busy !== null || !prTitle.trim()}>
            <GitPullRequest size={14} aria-hidden="true" />
            {busy === "pr" ? t("review.working") : t("review.pushAndOpen")}
          </Button>
        ) : (
          <Button type="button" onClick={() => setPrOpen(true)} disabled={busy !== null || dirty || ahead === 0}>
            <GitPullRequest size={14} aria-hidden="true" />
            {t("review.openPr")}
          </Button>
        )}
        <Button type="button" variant="primary" onClick={merge} disabled={busy !== null || dirty || ahead === 0}>
          <GitMerge size={14} aria-hidden="true" />
          {busy === "merge"
            ? t("review.working")
            : confirmMerge
              ? t("review.confirmMerge", { base: status?.base ?? "" })
              : t("review.merge", { base: status?.base ?? "" })}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
