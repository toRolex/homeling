import { useLocale, LanguageSettings } from "./locale.tsx";
import { LocalizedUIError, type LocalizedCopy } from "./ui-copy.ts";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { fetchPaneHistory, fetchPendingRequests, fetchPersonas, fetchSnapshot } from "./api.ts";
import { sessionState, type SessionMode, type SessionSnapshot } from "./session-state.ts";
const SESSION_URL = `${import.meta.env.BASE_URL || "/lite/"}api/session`;
type SessionAction = "activity" | "establish" | "lock" | "unlock";

export function useSessionSnapshot(): SessionSnapshot {
  const [snapshot, setSnapshot] = useState(sessionState.get);
  useEffect(() => sessionState.subscribe(() => setSnapshot(sessionState.get())), []);
  return snapshot;
}

function errorCopy(status: number, action?: SessionAction, code?: string): LocalizedCopy {
  if (action === "unlock" && code === "session.invalid_secret") return { key: "session.invalidPassword" };
  if (status === 401 || status === 403) return { key: "session.identityDenied" };
  if (status === 429) return { key: "session.rateLimited" };
  if (status === 503) return { key: "session.unavailable" };
  return { key: "session.httpFailed", params: { status } };
}

function validSnapshot(value: unknown): value is SessionSnapshot & { mode: SessionMode; generation: string; serverNow: number } {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  if (typeof state.locked !== "boolean" || (state.mode !== "local-unlock" && state.mode !== "tailscale-identity") || typeof state.available !== "boolean" || typeof state.generation !== "string" || state.generation.length === 0 || !Number.isFinite(state.serverNow)) return false;
  if (state.locked) return true;
  return Number.isSafeInteger(state.epoch) && Number(state.epoch) > 0 && Number.isFinite(state.idleDeadline) && Number.isFinite(state.absoluteDeadline);
}

function logSessionFailure(action: SessionAction | undefined, response: Response, stage: string, error?: unknown): void {
  let url = "unavailable";
  try {
    const finalUrl = new URL(response.url || SESSION_URL, window.location.href);
    url = `${finalUrl.origin}${finalUrl.pathname}`;
  } catch { /* Diagnostics omit invalid URLs. */ }
  console.warn("[homeling-session] request failed", {
    method: action ? "POST" : "GET", action: action ?? "metadata", status: response.status,
    url, redirected: response.redirected, contentType: response.headers.get("content-type")?.split(";", 1)[0] ?? "",
    stage, errorName: error instanceof Error ? error.name : undefined,
  });
}

async function sessionRequest(action?: SessionAction, secret?: string): Promise<SessionSnapshot & { mode: SessionMode }> {
  const requestUrl = new URL(`${SESSION_URL}${action ? `/${action}` : ""}`, window.location.href);
  if (requestUrl.origin !== window.location.origin || requestUrl.search || requestUrl.hash) throw new LocalizedUIError("", { key: "session.protocolError" });
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: action ? "POST" : "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", ...(action ? { "content-type": "application/json" } : {}), ...(action === "activity" ? { "x-homeling-session-epoch": String(sessionState.get().epoch), "x-homeling-session-generation": sessionState.get().generation ?? "" } : {}) },
      ...(action ? { body: JSON.stringify(action === "unlock" ? { secret: secret ?? "" } : {}) } : {}),
    });
  } catch {
    throw new LocalizedUIError("", { key: "session.connectionFailed" });
  }
  const expectedUrl = requestUrl.href;
  if (response.redirected || (response.url !== "" && response.url !== expectedUrl)) {
    logSessionFailure(action, response, "final-url");
    throw new LocalizedUIError("", { key: "session.protocolError" });
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    logSessionFailure(action, response, "content-type");
    throw new LocalizedUIError("", response.ok ? { key: "session.protocolError" } : errorCopy(response.status, action));
  }
  let value: unknown;
  try { value = await response.json(); } catch (error) {
    logSessionFailure(action, response, "json-parse", error);
    throw new LocalizedUIError("", response.ok ? { key: "session.protocolError" } : errorCopy(response.status, action));
  }
  const code = value && typeof value === "object" && "code" in value && typeof value.code === "string" ? value.code : undefined;
  if (!response.ok) throw new LocalizedUIError("", errorCopy(response.status, action, code));
  if (!validSnapshot(value)) {
    logSessionFailure(action, response, "snapshot-shape");
    throw new LocalizedUIError("", { key: "session.protocolError" });
  }
  return value;
}

async function readCatchUp(): Promise<void> {
  const [personas] = await Promise.all([fetchPersonas(), fetchSnapshot(), fetchPendingRequests()]);
  const path = window.location.pathname;
  const personaMatch = path.match(/\/persona\/([^/]+)/);
  const paneMatch = path.match(/\/(?:p|t)\/([^/]+)$/);
  const paneId = paneMatch ? decodeURIComponent(paneMatch[1]!) : personaMatch
    ? personas.personas.find((persona) => persona.id === decodeURIComponent(personaMatch[1]!))?.mainPaneId
    : undefined;
  if (paneId) await fetchPaneHistory(paneId);
}

export function SessionLockButton() {
  const { t } = useLocale();
  const session = useSessionSnapshot();
  if (session.mode !== "local-unlock") return null;
  return <button type="button" className="min-h-11 rounded-xl border border-neutral-600 px-4 py-2 text-sm" onClick={() => {
    sessionState.lock();
    const fence = sessionState.version();
    void sessionRequest("lock").then((next) => {
      if (fence === sessionState.version() && next.locked) sessionState.apply(next);
    }).catch(() => { /* The dialog reports an unconfirmed server lock. */ });
  }}>{t("session.lock")}</button>;
}

/** The same children/router/key stay mounted; the dialog, never a redirect, owns locked focus. */
export function SessionBoundary({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const session = useSessionSnapshot();
  const blocked = session.locked || !session.ready;
  const identityMode = session.mode === "tailscale-identity";
  const localUnlockMode = session.mode === "local-unlock";
  const dialog = useRef<HTMLDialogElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const refreshing = useRef(false);
  const identityEstablishAttempted = useRef(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const [error, setError] = useState<LocalizedCopy | null>(null);

  async function refresh(action?: SessionAction, secret?: string): Promise<void> {
    if (refreshing.current) return;
    refreshing.current = true;
    busyRef.current = true;
    setBusy(true);
    const request = ++sequence.current;
    let fence = sessionState.version();
    try {
      let next = await sessionRequest(action, secret);
      if (request !== sequence.current || fence !== sessionState.version()) return;
      if (next.generation !== sessionState.get().generation) identityEstablishAttempted.current = false;
      if (sessionState.get().locked && !next.locked && action !== "unlock" && !(next.mode === "tailscale-identity" && (action === "establish" || action === undefined))) return;
      sessionState.apply(next);
      fence = sessionState.version();
      if (next.locked && next.mode === "tailscale-identity" && action !== "establish" && action !== "unlock" && !identityEstablishAttempted.current) {
        identityEstablishAttempted.current = true;
        next = await sessionRequest("establish");
        if (request !== sequence.current || sessionState.version() !== fence) return;
        if (next.locked || next.mode !== "tailscale-identity") throw new LocalizedUIError("", { key: "session.connectionFailed" });
        sessionState.apply(next);
        fence = sessionState.version();
        const confirmed = await sessionRequest();
        if (request !== sequence.current || fence !== sessionState.version()) return;
        if (confirmed.locked || confirmed.mode !== "tailscale-identity" || confirmed.epoch !== next.epoch || confirmed.generation !== next.generation) throw new LocalizedUIError("", { key: "session.cookieUnavailable" });
        next = confirmed;
        sessionState.apply(next);
        fence = sessionState.version();
      }
      if (next.locked) {
        if (next.mode === "tailscale-identity") throw new LocalizedUIError("", { key: "session.cookieUnavailable" });
        return;
      }
      if (!sessionState.get().ready) {
        await readCatchUp();
        if (request !== sequence.current || sessionState.version() !== fence || sessionState.get().locked || sessionState.get().epoch !== next.epoch || sessionState.get().generation !== next.generation) return;
        sessionState.caughtUp();
      }
      setError(null);
    } catch (failure) {
      if (request !== sequence.current || fence !== sessionState.version()) return;
      sessionState.lock();
      setError(failure instanceof LocalizedUIError ? failure.copy : { key: "session.connectionFailed" });
    } finally {
      if (request === sequence.current) {
        refreshing.current = false;
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    let active = true;
    const check = () => { if (active && document.visibilityState !== "hidden" && !busyRef.current) void refresh(); };
    const reconnect = () => {
      if (document.visibilityState !== "hidden") identityEstablishAttempted.current = false;
      check();
    };
    check();
    const timer = window.setInterval(check, 5_000);
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => { active = false; ++sequence.current; refreshing.current = false; busyRef.current = false; window.clearInterval(timer); window.removeEventListener("online", reconnect); document.removeEventListener("visibilitychange", reconnect); };
  }, []);
  useEffect(() => {
    const current = dialog.current;
    if (!current) return;
    if (blocked && !current.open) { current.showModal(); if (session.mode === "local-unlock") password.current?.focus(); }
    if (!blocked && current.open) current.close();
  }, [blocked, session.mode]);
  useEffect(() => {
    if (blocked || session.idleDeadline === undefined) return;
    const remaining = Math.min(session.idleDeadline, session.absoluteDeadline ?? Infinity) - (session.serverNow ?? Date.now());
    const timer = window.setTimeout(() => {
      identityEstablishAttempted.current = false;
      sessionState.lock();
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [blocked, session.idleDeadline, session.absoluteDeadline, session.serverNow]);
  useEffect(() => {
    let lastActivity = 0;
    const activity = (event: Event) => {
      if (!event.isTrusted || document.visibilityState === "hidden" || !sessionState.get().ready || Date.now() - lastActivity < 30_000) return;
      lastActivity = Date.now();
      const fence = sessionState.version();
      void sessionRequest("activity").then((next) => { if (fence === sessionState.version()) sessionState.apply(next); }).catch(() => { if (fence === sessionState.version()) sessionState.lock(); });
    };
    document.addEventListener("pointerdown", activity); document.addEventListener("keydown", activity);
    return () => { document.removeEventListener("pointerdown", activity); document.removeEventListener("keydown", activity); };
  }, []);
  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const secret = password.current?.value ?? "";
    if (password.current) password.current.value = "";
    setError(null);
    await refresh("unlock", secret);
  }
  async function retryConnection() {
    if (refreshing.current) return;
    identityEstablishAttempted.current = false;
    setError(null);
    await refresh();
  }

  return <>
    <div inert={blocked}>{children}</div>
    <dialog ref={dialog} aria-labelledby="homeling-lock-title" onCancel={(event) => event.preventDefault()} className="m-auto w-[min(92vw,28rem)] rounded-3xl border border-neutral-700 bg-neutral-950 p-6 text-neutral-100 shadow-2xl backdrop:bg-neutral-950/95">
      <h1 id="homeling-lock-title" className="text-xl font-semibold">{!localUnlockMode ? t("session.connecting") : t(session.lockConfirmed ? "session.locked" : "session.localOnly")}</h1>
      {localUnlockMode && !session.lockConfirmed ? <p role="alert" className="mt-2 text-sm leading-6 text-amber-300">{t("session.lockUnconfirmed")}</p> : null}
      <p className="mt-2 text-sm leading-6 text-neutral-400">{localUnlockMode ? t("session.draftsRetained") : t(identityMode ? "session.identityHelp" : "session.connectionHelp")}</p>
      {localUnlockMode ? <form onSubmit={(event) => void unlock(event)} className="mt-5 flex flex-col gap-3">
        <label htmlFor="homeling-unlock-secret" className="text-sm">{t("session.password")}</label>
        <input ref={password} id="homeling-unlock-secret" type="password" autoComplete="off" required minLength={43} maxLength={43} spellCheck={false} className="min-h-11 rounded-xl border border-neutral-600 bg-neutral-900 px-3" aria-describedby="homeling-unlock-help" />
        <p id="homeling-unlock-help" className="text-xs leading-5 text-neutral-400">{t("session.localSecretHint")}</p>
        {error ? <p role="alert" className="text-sm text-amber-300">{t(error.key, error.params)}</p> : null}
        {session.available === false ? <p role="status" className="text-sm text-amber-300">{t("session.initialize")}</p> : null}
        <button disabled={busy || session.available === false} className="min-h-11 rounded-xl bg-green-800 px-4 text-sm font-medium disabled:opacity-50">{busy ? t("session.checking") : t("session.unlock")}</button>
        <button type="button" disabled={busy} className="min-h-11 rounded-xl border border-neutral-700 px-4 text-sm" onClick={() => void refresh()}>{t("session.checkAgain")}</button>
      </form> : <div className="mt-5 flex flex-col gap-3">
        {busy ? <p role="status" className="text-sm text-neutral-300">{t("session.connecting")}</p> : null}
        {error ? <p role="alert" className="text-sm text-amber-300">{t(error.key, error.params)}</p> : null}
        <button type="button" disabled={busy} className="min-h-11 rounded-xl border border-neutral-700 px-4 text-sm disabled:opacity-50" onClick={() => void retryConnection()}>{t("session.retryConnection")}</button>
      </div>}
      <LanguageSettings id="homeling-locked-language" />
    </dialog>
  </>;
}
