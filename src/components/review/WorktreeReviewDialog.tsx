import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { Check, Copy, GitBranch, GitMerge, GitPullRequest, RefreshCw } from "lucide-react";
import { useWorktreeReview } from "../../app/useWorktreeReview";
import { useT } from "../../i18n";
import { useMcpStore } from "../../stores/mcpStore";
import { useReviewStore } from "../../stores/reviewStore";
import { DialogFooter, TerraDialog } from "../overlays/Dialog";
import { Button } from "../ui/Button";
import { parsePatch, suggestTitle, type DiffFileSection } from "./diffModel";
import "./review.css";

const COPIED_FEEDBACK_MS = 1500;
const MAX_COMMIT_MESSAGE_CHARS = 300;
const MAX_PR_TITLE_CHARS = 200;

export function WorktreeReviewDialog() {
  const translate = useT();
  const target = useReviewStore((state) => state.target);
  const close = useReviewStore((state) => state.close);
  const summary = useMcpStore((state) => (target ? state.statuses[target.terminalId]?.summary : undefined));
  const review = useWorktreeReview(target);
  const { diff, busy, error, notice, prUrl } = review;
  const [chosen, setChosen] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [isConfirmingMerge, setConfirmMerge] = useState(false);
  const [isPrOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [isCopied, setCopied] = useState(false);

  const suggestDraftTitle = useEffectEvent((label: string) => suggestTitle(label, summary));

  useEffect(() => {
    setChosen(null);
    setConfirmMerge(false);
    setPrOpen(false);
    if (!target) return;
    const title = suggestDraftTitle(target.label);
    setMessage(title);
    setPrTitle(title);
    setPrBody("");
  }, [target]);

  const selected = chosen && diff?.files.some((file) => file.path === chosen) ? chosen : diff?.files[0]?.path ?? null;
  const sections = useMemo(() => parsePatch(diff?.patch ?? ""), [diff?.patch]);
  const section: DiffFileSection | undefined = sections.find((candidate) => candidate.path === selected);
  const status = diff?.status;
  const isDirty = status ? status.dirty.length > 0 : false;
  const ahead = status?.ahead ?? 0;

  const commit = () => review.commit(message);

  const merge = () => {
    if (!isConfirmingMerge) {
      setConfirmMerge(true);
      return;
    }
    setConfirmMerge(false);
    void review.merge();
  };

  const openPr = async () => {
    if (await review.openPullRequest(prTitle, prBody)) setPrOpen(false);
  };

  const copyUrl = async () => {
    if (!prUrl) return;
    try {
      await navigator.clipboard.writeText(prUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch (error) {
      console.warn("failed to copy the pull request URL:", error);
      setCopied(false);
    }
  };


  return (
    <TerraDialog
      className="terra-review"
      open={target !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) close();
      }}
      title={translate("review.title", { name: target?.label ?? "" })}
      description={
        status ? (
          <span className="terra-review-branch">
            <GitBranch size={12} aria-hidden="true" />
            {translate("review.branchLine", { branch: status.branch, base: status.base })}
            <span className="terra-review-stat">{translate("review.ahead", { count: status.ahead })}</span>
            {status.behind > 0 ? <span className="terra-review-stat">{translate("review.behind", { count: status.behind })}</span> : null}
            {isDirty ? <span className="terra-review-stat" data-tone="warn">{translate("review.dirty", { count: status.dirty.length })}</span> : null}
          </span>
        ) : (
          translate("review.loading")
        )
      }
    >
      <div className="terra-review-body">
        <nav className="terra-review-files" aria-label={translate("review.files")}>
          <div className="terra-review-files-head">
            <span>{translate("review.filesCount", { count: diff?.files.length ?? 0 })}</span>
            <button type="button" className="terra-review-icon" onClick={() => void review.load()} disabled={busy !== null} aria-label={translate("review.refresh")} title={translate("review.refresh")}>
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </div>
          {diff && diff.files.length === 0 ? <p className="terra-review-empty">{translate("review.noChanges")}</p> : null}
          <ul>
            {diff?.files.map((file) => (
              <li key={file.path}>
                <button type="button" data-active={file.path === selected} onClick={() => setChosen(file.path)} title={file.path}>
                  <span className="terra-review-change" data-change={file.change}>{translate(`review.change.${file.change}`)}</span>
                  <span className="terra-review-path">{file.path}</span>
                  {file.additions === null ? (
                    <span className="terra-review-counts">{translate("review.binary")}</span>
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
        <div className="terra-review-diff" role="region" aria-label={translate("review.diff")}>
          {diff?.isTruncated ? <p className="terra-review-empty">{translate("review.truncated")}</p> : null}
          {section ? (
            section.isBinary ? (
              <p className="terra-review-empty">{translate("review.binaryFile")}</p>
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
            <p className="terra-review-empty">{translate("review.notInPatch")}</p>
          ) : null}
        </div>
      </div>

      {error ? <p className="terra-review-error" role="alert">{error}</p> : null}
      {notice ? <p className="terra-review-notice" role="status">{notice}</p> : null}
      {prUrl ? (
        <p className="terra-review-notice">
          <a href={prUrl} target="_blank" rel="noreferrer">{prUrl}</a>
          <button type="button" className="terra-review-icon" onClick={() => void copyUrl()} aria-label={translate("review.copyUrl")} title={translate("review.copyUrl")}>
            {isCopied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          </button>
        </p>
      ) : null}

      {isDirty ? (
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
            placeholder={translate("review.commitPlaceholder")}
            aria-label={translate("review.commitMessage")}
            maxLength={MAX_COMMIT_MESSAGE_CHARS}
          />
          <Button type="submit" disabled={busy !== null || !message.trim()}>
            {busy === "commit" ? translate("review.working") : translate("review.commit")}
          </Button>
        </form>
      ) : null}

      {isPrOpen ? (
        <div className="terra-review-pr">
          <input value={prTitle} onChange={(event) => setPrTitle(event.target.value)} aria-label={translate("review.prTitle")} placeholder={translate("review.prTitle")} maxLength={MAX_PR_TITLE_CHARS} />
          <textarea value={prBody} onChange={(event) => setPrBody(event.target.value)} aria-label={translate("review.prBody")} placeholder={translate("review.prBody")} rows={4} />
          <p className="terra-review-hint">{translate("review.prHint", { branch: status?.branch ?? "", base: status?.base ?? "" })}</p>
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={close}>
          {translate("common.close")}
        </Button>
        {isPrOpen ? (
          <Button type="button" onClick={() => void openPr()} disabled={busy !== null || !prTitle.trim()}>
            <GitPullRequest size={14} aria-hidden="true" />
            {busy === "pr" ? translate("review.working") : translate("review.pushAndOpen")}
          </Button>
        ) : (
          <Button type="button" onClick={() => setPrOpen(true)} disabled={busy !== null || isDirty || ahead === 0}>
            <GitPullRequest size={14} aria-hidden="true" />
            {translate("review.openPr")}
          </Button>
        )}
        <Button type="button" variant="primary" onClick={merge} disabled={busy !== null || isDirty || ahead === 0}>
          <GitMerge size={14} aria-hidden="true" />
          {busy === "merge"
            ? translate("review.working")
            : isConfirmingMerge
              ? translate("review.confirmMerge", { base: status?.base ?? "" })
              : translate("review.merge", { base: status?.base ?? "" })}
        </Button>
      </DialogFooter>
    </TerraDialog>
  );
}
