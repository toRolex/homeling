import { useLocale, type Translate } from "./locale.tsx";
import { useRef, useState, type ReactElement } from "react";
import type { PendingRequest, PendingRequestStatus } from "@homeling/contracts";
import { ReplyRequestError, type ApprovalResponse } from "./api.ts";
import { createSingleFlightApproval } from "./approval-guard.ts";

export interface PendingRequestCardProps {
  request: PendingRequest;
  onApprove: (requestId: string, optionId: string, freeText?: string) => Promise<ApprovalResponse>;
  onSettled?: (request: PendingRequest) => void;
}

function statusLabel(t: Translate, status: PendingRequestStatus, unknown = false): string {
  if (status === "expired") return t("permission.expired");
  if (status === "resolved") return unknown ? t("permission.unknown") : t("permission.resolved");
  return t("permission.pending");
}

export function PendingRequestCard({ request, onApprove, onSettled }: PendingRequestCardProps): ReactElement {
  const { t } = useLocale();
  const [freeText, setFreeText] = useState("");
  const freeTextRef = useRef("");
  const collaboration = request.kind === "prompt-select" ? request.payload.collaboration : undefined;
  const [status, setStatus] = useState<PendingRequestStatus>(request.status);
  const [busyOption, setBusyOption] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submit = useRef<((optionId: string) => Promise<ApprovalResponse | null>) | null>(null);
  if (!submit.current) submit.current = createSingleFlightApproval((optionId) => onApprove(request.id, optionId, optionId === "__free_text__" ? freeTextRef.current : undefined));
  const visibleStatus = request.status === "pending" ? status : request.status;
  const disabled = visibleStatus !== "pending" || busyOption !== null;

  async function choose(optionId: string): Promise<void> {
    if (disabled) return;
    setMessage(null);
    setBusyOption(optionId);
    try {
      const result = await submit.current!(optionId);
      if (result === null) return;
      if (result.outcome === "not-submitted") {
        setMessage("permission.notSubmitted");
        return;
      }
      const nextStatus: PendingRequestStatus = result.status === "pending"
        ? result.outcome === "stale" ? "expired" : "resolved"
        : result.status;
      const unknown = result.outcome === "unknown";
      setMessage(null);
      setStatus(nextStatus);
      setUncertain(unknown);
      onSettled?.({ ...request, status: nextStatus });
    } catch (error) {
      if (error instanceof ReplyRequestError && error.textDelivered === false) {
        setMessage("permission.lockedNotSubmitted");
        return;
      }
      // The upstream may have accepted a key before the connection failed: never enable a duplicate tap.
      setStatus("resolved");
      setUncertain(true);
      onSettled?.({ ...request, status: "resolved" });
    } finally {
      setBusyOption(null);
    }
  }

  return (
    <article
      aria-label={request.kind === "preview-select" ? t("permission.previewRequest") : t("permission.request")}
      className="w-full rounded-2xl border border-amber-700/70 bg-amber-950/35 p-4 text-amber-50"
      data-request-id={request.id}
      data-status={visibleStatus}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-amber-200">{request.kind === "preview-select" ? t("permission.preview") : t("permission.needsYou")}</p>
          <h2 className="mt-1 text-sm font-semibold leading-5">{request.payload.question}</h2>
        </div>
        <p role="status" className="shrink-0 text-right text-xs text-amber-200">{message ? t(message) : statusLabel(t, visibleStatus, uncertain)}</p>
      </div>
      {request.kind === "prompt-select" && request.payload.subject?.length ? (
        <div className="mb-3 rounded-lg bg-black/20 px-3 py-2 text-xs text-amber-100/90">
          {request.payload.subject.map((line, index) => <p key={index}>{line}</p>)}
        </div>
      ) : null}
      {request.kind === "preview-select" && request.payload.preview.length > 0 ? (
        <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 font-mono text-xs leading-5 text-neutral-100">
          {request.payload.preview.join("\n")}
        </pre>
      ) : null}
      {collaboration?.details.length ? <details className="mb-3 text-xs">
        <summary className="cursor-pointer">{t("permission.collaborationDetails")}</summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{collaboration.details.join("\n")}</pre>
      </details> : null}
      {collaboration?.freeText ? <div className="mb-3 flex gap-2">
        <textarea value={freeText} disabled={disabled} maxLength={10000}
          aria-label={t("permission.collaborationAnswer")} className="min-w-0 flex-1 rounded-lg bg-black/20 p-2 text-sm"
          onChange={event => { setFreeText(event.target.value); freeTextRef.current = event.target.value; }} />
        <button type="button" disabled={disabled || !freeText.trim()} onClick={() => void choose("__free_text__")}
          className="rounded-lg border border-amber-700 px-3 disabled:opacity-50">{t("common.send")}</button>
      </div> : null}
      <div className="flex flex-col gap-2">
        {request.payload.options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={disabled}
            onClick={() => void choose(option.id)}
            className="min-h-11 rounded-xl border border-amber-700/70 bg-amber-900/50 px-3 py-2 text-left text-sm font-medium text-amber-50 transition-colors hover:bg-amber-800/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyOption === option.id ? t("permission.processing") : ""}{option.label}
          </button>
        ))}
      </div>
    </article>
  );
}
