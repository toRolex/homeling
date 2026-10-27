/** Shared pending approval request contract for daemon, UI, push, and triage consumers. */
export type PendingRequestStatus = "pending" | "resolved" | "expired";

export interface RequestOption {
  readonly id: string;
  readonly label: string;
}

export interface PromptSelectPayload {
  readonly question: string;
  readonly subject?: readonly string[];
  readonly collaboration?: {
    readonly freeText: boolean;
    readonly details: readonly string[];
  };
  readonly options: readonly RequestOption[];
}

export interface PreviewSelectPayload {
  readonly question: string;
  readonly options: readonly RequestOption[];
  readonly preview: readonly string[];
}

interface PendingRequestBase {
  /** Stable identity of this observed request, not the pane identity. */
  readonly id: string;
  readonly paneId: string;
  /** Real daemon registry identity. Absent for legacy Collie panes; never a workspace ID. */
  readonly personaId?: string;
  /** Trusted persistent task lifecycle, supplied only by the daemon Activity ledger. */
  readonly taskOccurrenceKey?: string;
  readonly createdAt: string;
  readonly status: PendingRequestStatus;
}

export type PendingRequest =
  | (PendingRequestBase & { readonly kind: "prompt-select"; readonly payload: PromptSelectPayload })
  | (PendingRequestBase & { readonly kind: "preview-select"; readonly payload: PreviewSelectPayload });

/** Idempotent by stable id; only explicit evidence of a pre-write refusal may revive a resolved item. */
export function upsertPendingRequest(
  requests: readonly PendingRequest[],
  incoming: PendingRequest,
  observation: { readonly outcome?: "not-submitted" } = {},
): PendingRequest[] {
  const existing = requests.find((request) => request.id === incoming.id);
  if (!existing) return [...requests, incoming];
  const canRefresh = existing.status === "pending" ||
    (existing.status === "resolved" && incoming.status === "pending" && observation.outcome === "not-submitted");
  if (!canRefresh) return [...requests];
  return requests.map((request) => request.id === incoming.id
    ? { ...incoming, createdAt: existing.createdAt, status: "pending" }
    : request);
}

/** Only pending requests may settle; repeated or conflicting settlements are harmless no-ops. */
export function transitionRequest(
  requests: readonly PendingRequest[],
  id: string,
  status: Exclude<PendingRequestStatus, "pending">,
): PendingRequest[] {
  let changed = false;
  const next = requests.map((request) => {
    if (request.id !== id || request.status !== "pending") return request;
    changed = true;
    return { ...request, status };
  });
  return changed ? next : [...requests];
}
