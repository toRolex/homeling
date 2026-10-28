import { useLocale, type Translate } from "./locale.tsx";
import { LocalizedUIError, type LocalizedCopy } from "./ui-copy.ts";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { mapTaskStatuses, mergeTranscripts, paneControlIdentity, transcriptToMessages, type Launcher, type PaneHistoryResponse, type PendingRequest, type PersonaView, type SnapshotResponse, type Task } from "@homeling/contracts";
import { useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { ActivityTaskBoundary } from './ActivityTaskBoundary.tsx';
import { approvePendingRequest, fetchLaunchers, fetchPaneHistory, fetchPendingRequests, fetchPersonas, fetchSnapshot, launchTask, ReplyRequestError, sendPaneReply, sendPersonaMessage } from "./api.ts";
import { PendingRequestCard } from "./PendingRequestCard.tsx";
import { RequestPollState } from "./request-poll-state.ts";
import { toAssistantMessages } from "./assistant-messages.ts";
import { ConversationMessage } from "./ConversationMessage.tsx";
import { historyReducer, initialHistoryState, optimisticEntries, reconcileOutgoing, type HistoryAction, type OutgoingMessage } from "./history-reducer.ts";
import { startAbortableSerialPolling } from "./polling.ts";
import { ReplyComposer } from "./ReplyComposer.tsx";
import { SpecialKeyBar } from "./SpecialKeyBar.tsx";
import { TaskChip } from "./TaskChip.tsx";
import { PersonaAvatar } from "./PersonaAvatar.tsx";
import { conversationTaskStorageKey, readConversationTasks, saveConversationTasks } from "./task-store.ts";
import { guardUnknownRetry, createDeferredSendQueue, enqueueUnlessConfirmed } from "./send-queue.ts";

import { useSessionSnapshot } from "./SessionBoundary.tsx";
import { sessionState } from "./session-state.ts";

type HistoryPageKind = Extract<HistoryAction, { type: "received" }>["pageKind"];

interface PaneConversationProps {
  paneId: string;
  personaId?: string;
  persona?: PersonaView;
  draft: string;
  setDraft: (value: string) => void;
  occurrenceKey?: string;
  personaStale?: boolean;
}

function failureLabel(t: Translate, message: OutgoingMessage): string {
  if (message.deliveryUnknown) return t("task.deliveryUnknownRetry");
  if (message.textDelivered) return t("task.submitAgain");
  return t("task.sendFailed");
}

function PaneConversation({ paneId, personaId, persona, draft, setDraft, personaStale = false, occurrenceKey }: PaneConversationProps): ReactElement {
  const { t } = useLocale();
  const renderCopy = (copy: LocalizedCopy) => t(copy.key, { ...copy.params, error: copy.params?.error || t("common.unknownError") });
  const lockSession = useSessionSnapshot();
  const taskStorageKey = occurrenceKey === undefined ? conversationTaskStorageKey(paneId, personaId) : `task-occurrence:${occurrenceKey}`;
  const [history, dispatch] = useReducer(historyReducer, paneId, initialHistoryState);
  const historyRef = useRef(history);
  historyRef.current = history;
  const outgoingRef = useRef(history.outgoing);
  outgoingRef.current = history.outgoing;
  const confirmedMessageIds = useRef(new Set<string>());
  const [error, setError] = useState<LocalizedCopy | null>(null);
  const [launchers, setLaunchers] = useState<readonly Launcher[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [snapshotHealthy, setSnapshotHealthy] = useState(false);
  const [controlBlocked, setControlBlocked] = useState(false);
  const controlBlockedRef = useRef(false);
  const [tasks, setTasks] = useState<Task[]>(() => readConversationTasks(taskStorageKey));
  const [launchOpen, setLaunchOpen] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<LocalizedCopy | null>(null);
  const [requestError, setRequestError] = useState<LocalizedCopy | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [settledRequests, setSettledRequests] = useState<PendingRequest[]>([]);
  const requestPollState = useRef<RequestPollState | null>(null);
  if (!requestPollState.current) requestPollState.current = new RequestPollState();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sendBlocked, setSendBlocked] = useState(false);
  const sendBlockedRef = useRef(false);
  const blockedMessageIds = useRef(new Set<string>());
  const [sendQueue] = useState(() => createDeferredSendQueue(sessionState.admit, (id) => {
    dispatch({ type: "outgoing-failed", paneId, id, textDelivered: false });
    queuedMessageIds.current.delete(id);
  }));
  const sendAttemptSequence = useRef(0);
  const queuedMessageIds = useRef(new Set<string>());
  const requestSequence = useRef(0);
  const latestSuccessSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!lockSession.ready) sendQueue.suspend();
  }, [lockSession.ready, lockSession.epoch]);

  function setComposerBlocked(blocked: boolean): void {
    sendBlockedRef.current = blocked;
    setSendBlocked(blocked);
  }

  function blockUntilResolved(id: string): void {
    blockedMessageIds.current.add(id);
    sendQueue.block(id);
    setComposerBlocked(true);
  }

  function unblockResolved(id: string): void {
    blockedMessageIds.current.delete(id);
    sendQueue.unblock(id);
    setComposerBlocked(blockedMessageIds.current.size > 0);
  }

  useEffect(() => {
    for (const message of history.outgoing) {
      if (message.matchedUuid && blockedMessageIds.current.has(message.id)) unblockResolved(message.id);
    }
    setComposerBlocked(blockedMessageIds.current.size > 0);
  }, [history.outgoing]);

  function receiveHistory(response: PaneHistoryResponse, requestId: number, pageKind?: HistoryPageKind): void {
    if (!response.available) {
      dispatch({ type: "unavailable", paneId, requestId });
      if (requestId >= latestSuccessSequence.current) setError({ key: "conversation.historyReason", params: { reason: response.reason } });
      return;
    }
    const confirmationEntries = mergeTranscripts([historyRef.current.entries, response.entries]);
    for (const message of reconcileOutgoing(outgoingRef.current, confirmationEntries)) {
      if (message.matchedUuid) confirmedMessageIds.current.add(message.id);
    }
    dispatch({
      type: "received", paneId, requestId, entries: response.entries, pageKind,
      hasMore: response.hasMore, fileTruncated: response.fileTruncated,
    });
    if (requestId >= latestSuccessSequence.current) {
      latestSuccessSequence.current = requestId;
      setError(null);
    }
  }

  useEffect(() => {
    if (!lockSession.ready) return;
    const session = startAbortableSerialPolling(async (signal) => {
      const requestId = ++requestSequence.current;
      dispatch({ type: "started", paneId, requestId });
      try {
        const response = await fetchPaneHistory(paneId, signal, undefined, occurrenceKey);
        if (signal.aborted) return;
        receiveHistory(response, requestId);
      } catch (err: unknown) {
        if (!signal.aborted && requestId >= latestSuccessSequence.current) {
          setError(err instanceof LocalizedUIError ? err.copy : { key: "conversation.historyFailed", params: { error: err instanceof Error ? err.message : "" } });
        }
      }
    }, 2000);
    activeController.current = session.controller;
    return () => {
      if (activeController.current === session.controller) activeController.current = null;
      session.stop();
    };
  }, [paneId, occurrenceKey, lockSession.ready, lockSession.epoch]);

  useEffect(() => {
    if (!lockSession.ready) return;
    const controller = new AbortController();
    void fetchLaunchers(controller.signal).then((response) => {
      if (!controller.signal.aborted) {
        setLaunchers(response.launchers);
        setSelectedCommand((current) => current || response.launchers[0]?.command || "");
      }
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setLaunchError(err instanceof LocalizedUIError ? err.copy : { key: "conversation.launchersFailed", params: { error: err instanceof Error ? err.message : "" } });
    });
    const session = startAbortableSerialPolling(async (signal) => {
      try {
        const next = await fetchSnapshot(signal);
        if (!signal.aborted) {
          setSnapshot((current) => current && current.ts > next.ts ? current : next);
          setSnapshotHealthy(next.bridge === "connected");
        }
      } catch {
        if (!signal.aborted) setSnapshotHealthy(false);
        // Keep the last snapshot so an intermittent read does not erase task status.
      }
    }, 3000);
    return () => {
      controller.abort();
      session.stop();
    };
  }, [lockSession.ready, lockSession.epoch]);

  useEffect(() => {
    saveConversationTasks(taskStorageKey, tasks);
  }, [taskStorageKey, tasks]);

  const controlPane = snapshotHealthy && snapshot?.bridge === "connected"
    ? [...snapshot.agents, ...snapshot.shellPanes].find((pane) => pane.paneId === paneId && ["idle", "working"].includes(pane.status))
    : undefined;
  const controlIdentity = controlPane ? paneControlIdentity(controlPane) : null;

  const visibleTasks = useMemo(
    () => snapshot ? mapTaskStatuses(tasks, snapshot) : tasks,
    [snapshot, tasks],
  );

  async function launchSelectedTask(): Promise<void> {
    const selected = launchers.find((launcher) => launcher.command === selectedCommand);
    if (!selected || launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const result = await launchTask(selected, personaId ? undefined : paneId, personaId);
      setTasks((current) => [...current, {
        paneId: result.pane.paneId,
        launcher: selected,
        createdAt: Date.now(),
        status: "unknown",
      }]);
      setLaunchOpen(false);
    } catch (err: unknown) {
      setLaunchError(err instanceof LocalizedUIError ? err.copy : { key: "conversation.launchFailed", params: { error: err instanceof Error ? err.message : "" } });
    } finally {
      setLaunching(false);
    }
  }

  useEffect(() => {
    if (!lockSession.ready) return;
    const session = startAbortableSerialPolling(async (signal) => {
      const pollVersion = requestPollState.current!.begin();
      try {
        const requests = await fetchPendingRequests(signal, occurrenceKey);
        if (signal.aborted) return;
        const update = requestPollState.current!.accept(pollVersion, requests, paneId);
        if (!update) return;
        for (const request of update.settled) {
          if (request.kind === "prompt-select" && request.payload.collaboration) continue;
          window.setTimeout(() => {
            setSettledRequests((current) => current.filter((item) => item.id !== request.id));
          }, 5000);
        }
        if (update.settled.length > 0) {
          setSettledRequests((current) => [
            ...current.filter((item) => !update.settled.some((gone) => gone.id === item.id)),
            ...update.settled,
          ]);
        }
        setPendingRequests(update.pending);
        setRequestError(null);
      } catch (err: unknown) {
        if (!signal.aborted && requestPollState.current!.isCurrent(pollVersion)) {
          setRequestError(err instanceof LocalizedUIError ? err.copy : { key: "conversation.requestsFailed", params: { error: err instanceof Error ? err.message : "" } });
        }
      }
    }, 2000);
    return () => session.stop();
  }, [paneId, occurrenceKey, lockSession.ready, lockSession.epoch]);

  function keepSettledRequest(request: PendingRequest): void {
    requestPollState.current!.settle(request.id);
    setPendingRequests((current) => current.filter((item) => item.id !== request.id));
    setSettledRequests((current) => [...current.filter((item) => item.id !== request.id), request]);
    // Cooperation may still need inspection/advance after the answer was saved.
    if (request.kind === "prompt-select" && request.payload.collaboration) return;
    window.setTimeout(() => {
      setSettledRequests((current) => current.filter((item) => item.id !== request.id));
    }, 5000);
  }

  async function loadOlder(): Promise<void> {
    const cursor = history.beforeCursor;
    const controller = activeController.current;
    if (!history.hasMore || !cursor || loadingOlder || !controller) return;
    const requestId = ++requestSequence.current;
    setLoadingOlder(true);
    dispatch({ type: "started", paneId, requestId });
    try {
      const response = await fetchPaneHistory(paneId, controller.signal, cursor, occurrenceKey);
      if (controller.signal.aborted) return;
      receiveHistory(response, requestId, "older");
    } catch (err: unknown) {
      if (!controller.signal.aborted && requestId >= latestSuccessSequence.current) {
        setError(err instanceof LocalizedUIError ? err.copy : { key: "conversation.historyFailed", params: { error: err instanceof Error ? err.message : "" } });
      }
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

  const retryLifetime = useRef(new AbortController());
  useEffect(() => {
    const lifetime = new AbortController(); retryLifetime.current = lifetime;
    return () => lifetime.abort();
  }, []);
  const retryCheckingIds = useRef(new Set<string>());
  async function retryGuard(message: OutgoingMessage, confirm: boolean, check: () => void, signal: AbortSignal): Promise<boolean> {
    return guardUnknownRetry({
      admit: () => check, signal,
      refresh: async () => {
        const response = await fetchPaneHistory(paneId, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), undefined, occurrenceKey);
        signal.throwIfAborted();
        check();
        if (!response.available) throw new Error("History unavailable");
        receiveHistory(response, ++requestSequence.current);
      },
      isConfirmed: () => confirmedMessageIds.current.has(message.id) || historyRef.current.outgoing.some(item => item.id === message.id && !!item.matchedUuid),
      confirm: confirm ? () => window.confirm(t("task.unknownRetryConfirm")) : undefined,
    });
  }
  async function sendMessage(text: string, existing?: OutgoingMessage): Promise<void> {
    if (controlBlockedRef.current || (sendBlockedRef.current && !existing)) return;
    if (existing && (queuedMessageIds.current.has(existing.id) || retryCheckingIds.current.has(existing.id))) return;
    const lifetime = retryLifetime.current.signal;
    let check: () => void;
    try { check = sessionState.admit(); } catch { return; }
    if (existing?.deliveryUnknown && !existing.textDelivered) {
      retryCheckingIds.current.add(existing.id);
      const allowed = await retryGuard(existing, true, check, lifetime);
      retryCheckingIds.current.delete(existing.id);
      if (!allowed || controlBlockedRef.current) return;
    }
    const outgoing: OutgoingMessage = existing
      ? { ...existing, status: "pending", retryQueued: true }
      : {
          id: `optimistic-${crypto.randomUUID()}`,
          text,
          sentAt: Date.now(),
          attemptOrder: ++sendAttemptSequence.current,
          status: "pending",
        };
    queuedMessageIds.current.add(outgoing.id);
    if (existing) {
      outgoingRef.current = outgoingRef.current.map((message) => message.id === existing.id ? outgoing : message);
      dispatch({ type: "outgoing-retry", paneId, id: existing.id });
    } else {
      outgoingRef.current = [...outgoingRef.current, outgoing];
      dispatch({
        type: "outgoing-added", paneId, id: outgoing.id, text: outgoing.text,
        sentAt: outgoing.sentAt, attemptOrder: outgoing.attemptOrder,
      });
    }

    void enqueueUnlessConfirmed(
      sendQueue,
      outgoing.id,
      () => {
        const confirmed = confirmedMessageIds.current.has(outgoing.id) ||
          historyRef.current.outgoing.some((message) => message.id === outgoing.id && message.matchedUuid);
        if (confirmed) unblockResolved(outgoing.id);
        return confirmed;
      },
      async () => {
        if (lifetime.aborted) return;
        try { check(); } catch { return; }
        if (existing?.deliveryUnknown && !existing.textDelivered && !await retryGuard(existing, false, check, lifetime)) {
          if (!confirmedMessageIds.current.has(existing.id)) dispatch({ type: "outgoing-failed", paneId, id: existing.id, textDelivered: null });
          return;
        }
        const attemptOrder = ++sendAttemptSequence.current;
        outgoingRef.current = outgoingRef.current.map((message) => message.id === outgoing.id
          ? { ...message, attemptOrder, retryQueued: false }
          : message);
        dispatch({ type: "outgoing-attempt-started", paneId, id: outgoing.id, attemptOrder });
        try {
          let confirmationText: string | undefined;
          if (existing?.textDelivered) await sendPaneReply(paneId, '', occurrenceKey);
          else if (personaId) confirmationText = await sendPersonaMessage(personaId, outgoing.text);
          else await sendPaneReply(paneId, outgoing.text, occurrenceKey);
          if (confirmationText) {
            outgoingRef.current = outgoingRef.current.map((message) => message.id === outgoing.id
              ? { ...message, confirmationText }
              : message);
            dispatch({ type: "outgoing-confirmation-text", paneId, id: outgoing.id, text: confirmationText });
          }
          if (existing?.textDelivered || existing?.deliveryUnknown) unblockResolved(outgoing.id);
        } catch (err: unknown) {
          const textDelivered = err instanceof ReplyRequestError ? err.textDelivered : null;
          const confirmationText = err instanceof ReplyRequestError ? err.confirmationText : undefined;
          if (confirmationText) {
            outgoingRef.current = outgoingRef.current.map((message) => message.id === outgoing.id
              ? { ...message, confirmationText }
              : message);
            dispatch({ type: "outgoing-confirmation-text", paneId, id: outgoing.id, text: confirmationText });
          }
          if (existing?.textDelivered || existing?.deliveryUnknown || textDelivered !== false) {
            blockUntilResolved(outgoing.id);
          }
          dispatch({ type: "outgoing-failed", paneId, id: outgoing.id, textDelivered });
        }
      },
    ).finally(() => queuedMessageIds.current.delete(outgoing.id));
  }

  function submitDraft(): void {
    if (controlBlockedRef.current || sendBlockedRef.current || !draft.trim()) return;
    const text = draft;
    setDraft("");
    sendMessage(text);
  }

  const runtimeMessages = useMemo(() => {
    const optimistic = optimisticEntries(history);
    const visibleEntries = optimistic.length === 0
      ? history.entries
      : mergeTranscripts([history.entries, optimistic]);
    const sendStatuses = new Map(
      history.outgoing.map((message) => [
        message.matchedUuid ?? message.id,
        message.deliveryUnknown ? "unknown" : message.textDelivered ? "text-entered" : message.status,
      ] as const),
    );
    return toAssistantMessages(transcriptToMessages(visibleEntries), sendStatuses);
  }, [history.entries, history.outgoing]);
  const runtime = useExternalStoreRuntime({
    messages: runtimeMessages,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  const failedMessages = history.outgoing.filter((message) => message.status === "failed");
  const launchErrorNotice = launchError ? <p className="mt-2 text-sm text-red-300" role="alert">{renderCopy(launchError)}</p> : null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col px-4 py-4">
        <header className="sticky top-0 z-10 -mx-4 mb-4 border-b border-neutral-800 bg-[#1a1a1a]/95 px-4 py-3 backdrop-blur">
          <Link to="/" className="inline-block min-h-11 py-2 text-sm text-green-300 hover:text-green-200">{t("persona.backHome")}</Link>
          {persona ? <Link to={`/persona/${encodeURIComponent(persona.id)}/details`} className="flex min-h-16 items-center gap-3 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-green-300" aria-label={t("persona.detailsFor", { name: persona.name })}><PersonaAvatar avatar={persona.avatar} size="conversation" persona={persona} stale={personaStale || !snapshotHealthy || snapshot?.agents.find((agent) => agent.paneId === paneId)?.status !== "working"} /><h1 className="truncate text-lg font-medium">{persona.name}</h1><span className="ml-auto text-sm text-neutral-400">{t("conversation.details")}</span></Link> : <h1 className="mt-1 truncate text-base font-medium">{paneId}</h1>}
          <p className="text-xs text-neutral-400" role="status">
            {error ? renderCopy(error) : history.available === false ? t("conversation.historyUnavailable") : t("conversation.polling")}
          </p>
          <button
            type="button"
            onClick={() => { setLaunchOpen((open) => !open); setLaunchError(null); }}
            disabled={occurrenceKey !== undefined || launchers.length === 0}
            title={occurrenceKey === undefined ? undefined : t("conversation.launchFromMain")}
            className="mt-3 min-h-11 rounded-xl border border-green-800 px-4 py-2 text-sm text-green-200 disabled:opacity-50"
          >
            {t("conversation.launch")}
          </button>
          {launchOpen ? (
            <form
              className="mt-3 rounded-xl border border-neutral-700 bg-neutral-900 p-3"
              onSubmit={(event) => { event.preventDefault(); void launchSelectedTask(); }}
            >
              <label htmlFor="task-launcher" className="mb-2 block text-sm text-neutral-200">{t("conversation.chooseLauncher")}</label>
              <select
                id="task-launcher"
                value={selectedCommand}
                onChange={(event) => setSelectedCommand(event.currentTarget.value)}
                disabled={launching}
                className="min-h-11 w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 text-sm"
              >
                {launchers.map((launcher) => (
                  <option key={launcher.command} value={launcher.command}>{launcher.label}</option>
                ))}
              </select>
              {launchErrorNotice}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setLaunchOpen(false)} disabled={launching} className="min-h-11 rounded-lg px-4 text-sm text-neutral-300">{t("common.cancel")}</button>
                <button type="submit" disabled={!selectedCommand || launching} className="min-h-11 rounded-lg bg-green-800 px-4 text-sm text-white disabled:opacity-50">
                  {launching ? t("conversation.launching") : t("conversation.confirmLaunch")}
                </button>
              </div>
            </form>
          ) : launchErrorNotice}
          {requestError ? <p role="status" className="mt-1 text-xs text-amber-300">{renderCopy(requestError)}</p> : null}
        </header>
        <ThreadPrimitive.Root className="flex flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex flex-col gap-3 pb-8">
            {history.fileTruncated ? (
              <p className="rounded-xl border border-amber-800/70 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
                {t("conversation.truncated")}
              </p>
            ) : null}
            {history.hasMore ? (
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="mx-auto rounded-full border border-neutral-700 px-4 py-2 text-xs text-neutral-300 disabled:opacity-50"
              >
                {loadingOlder ? t("task.loadingOlder") : t("task.loadOlder")}
              </button>
            ) : null}
            {pendingRequests.length + settledRequests.length > 0 ? (
              <section aria-label={t("triage.label")} className="flex flex-col gap-3">
                {[...pendingRequests, ...settledRequests].map((request) => (
                  <PendingRequestCard
                    key={request.id}
                    request={request}
                    onApprove={(id, option, freeText) => approvePendingRequest(id, option, occurrenceKey ?? request.taskOccurrenceKey, freeText)}
                    onSettled={keepSettledRequest}
                  />
                ))}
              </section>
            ) : null}
            <ThreadPrimitive.Empty>
              <p className="py-8 text-center text-sm text-neutral-500">
                {error ? t("conversation.loadFailedRetained") : t("task.empty")}
              </p>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ Message: ConversationMessage }} />
            {visibleTasks.length > 0 ? (
              <ul aria-label={t("conversation.tasks")} className="mt-2 flex flex-col gap-2">
                {visibleTasks.map((task) => <TaskChip key={task.paneId} task={task} returnTo={personaId ? `/persona/${encodeURIComponent(personaId)}` : `/p/${encodeURIComponent(paneId)}`} />)}
              </ul>
            ) : null}
          </ThreadPrimitive.Viewport>
          {failedMessages.length > 0 ? (
            <section aria-label={t("task.failedMessages")} className="max-h-28 overflow-y-auto border-t border-neutral-800 py-2">
              {failedMessages.map((message) => (
                <div key={message.id} className="flex items-center justify-between gap-3 py-1 text-xs text-red-300">
                  <span className="truncate">
                    {failureLabel(t, message)}: {message.text}
                  </span>
                  <button
                    type="button"
                    onClick={() => sendMessage(message.text, message)}
                    className="shrink-0 rounded-lg border border-red-800 px-3 py-1.5 text-red-200"
                  >
                    {t("common.retry")}
                  </button>
                </div>
              ))}
            </section>
          ) : null}
          <SpecialKeyBar
            paneId={paneId}
            occurrenceKey={occurrenceKey}
            identity={controlIdentity}
            disabled={!lockSession.ready || sendBlocked || history.outgoing.some((message) => message.status === "pending") || pendingRequests.length > 0 || !!requestError}
            onBlockedChange={(blocked) => { controlBlockedRef.current = blocked; setControlBlocked(blocked); }}
          />
          <ReplyComposer scopeId={paneId} draft={draft} onDraftChange={setDraft} onSend={submitDraft} disabled={!lockSession.ready || sendBlocked || controlBlocked} disabledReason={controlBlocked ? t("conversation.controlUncertain") : undefined} />
        </ThreadPrimitive.Root>
      </main>
    </AssistantRuntimeProvider>
  );
}

async function fetchPersonaStatus(signal: AbortSignal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  if (bounded.aborted) throw bounded.reason;
  let expire!: () => void;
  const deadline = new Promise<never>((_, reject) => { expire = () => reject(bounded.reason); });
  bounded.addEventListener("abort", expire, { once: true });
  try {
    // Race the read itself: a transport ignoring abort must not retain stale thinking.
    return await Promise.race([fetchPersonas(bounded), deadline]);
  } finally { bounded.removeEventListener("abort", expire); }
}

export function ConversationPage(): ReactElement {
  const { t } = useLocale();
  const { paneId: routePaneId, personaId } = useParams();
  const routePaneIdValue = routePaneId ?? "";
  const lockSession = useSessionSnapshot();
  const [searchParams] = useSearchParams();
  const occurrenceKey = searchParams.get('occurrence');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = personaId ? `persona:${personaId}` : occurrenceKey === null ? `pane:${routePaneIdValue}` : `task-occurrence:${occurrenceKey}`;
  const draft = drafts[draftKey] ?? "";
  const setDraft = (value: string) => setDrafts((current) => ({ ...current, [draftKey]: value }));
  const [persona, setPersona] = useState<PersonaView | null>(null);
  const [personaLookupError, setPersonaLookupError] = useState<LocalizedCopy | null>(null);

  useEffect(() => {
    if (!personaId) {
      setPersona(null);
      setPersonaLookupError(null);
      return;
    }
    if (!lockSession.ready) return;
    const session = startAbortableSerialPolling(async (signal) => {
      try {
        const result = await fetchPersonaStatus(signal);
        if (signal.aborted) return;
        const current = result.personas.find((item) => item.id === personaId);
        setPersona(current ?? null);
        setPersonaLookupError(current ? null : { key: "conversation.personaNotFound" });
      } catch (error: unknown) {
        if (!signal.aborted) {
          setPersonaLookupError(error instanceof LocalizedUIError ? error.copy : { key: "conversation.personaResolveFailed", params: { error: error instanceof Error ? error.message : "" } });
        }
      }
    }, 3000);
    return () => session.stop();
  }, [personaId, lockSession.ready, lockSession.epoch]);

  if (personaId) {
    if (!persona || persona.id !== personaId) {
      return <main className="p-6 text-sm text-neutral-400" role={personaLookupError ? "alert" : "status"}>
        {personaLookupError ? t(personaLookupError.key, personaLookupError.params) : t("conversation.restoring")}
      </main>;
    }
    if (routePaneIdValue) {
      return <Navigate to={`/persona/${encodeURIComponent(personaId)}`} replace />;
    }
    return <>
      {personaLookupError ? <p role="status" className="mx-auto max-w-lg px-4 pt-3 text-sm text-amber-300">{t(personaLookupError.key, personaLookupError.params)}</p> : null}
      <PaneConversation key={persona.mainPaneId} paneId={persona.mainPaneId} personaId={persona.id} persona={persona} draft={draft} setDraft={setDraft} personaStale={personaLookupError !== null} />
    </>;
  }

  if (!routePaneIdValue) return <main className="p-6 text-sm">{t("task.paneIdMissing")}</main>;
  if (occurrenceKey !== null) {
    return <ActivityTaskBoundary paneId={routePaneIdValue} occurrenceKey={occurrenceKey} returnTo="/">
      {() => <PaneConversation key={`${routePaneIdValue}:${occurrenceKey}`} paneId={routePaneIdValue} occurrenceKey={occurrenceKey} draft={draft} setDraft={setDraft} />}
    </ActivityTaskBoundary>;
  }
  return <PaneConversation key={routePaneIdValue} paneId={routePaneIdValue} draft={draft} setDraft={setDraft} />;
}
