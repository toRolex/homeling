/**
 * Persona daemon entrypoint: Bun HTTP server on loopback :8790 serving the /lite UI from the
 * web build output plus the /lite/api/* routes, all behind the self-held access gate
 * (ADR-0004: zero-touch — nothing under ~/.local/share/collie is read or written).
 */
import { checkAccess, isLoopbackAddress, isLoopbackRequest, type AccessConfig } from "./access.ts";
import { safeErrorCode } from "./safe-error.ts";
import type { PaneWire } from '@homeling/contracts';
import { dirname, join } from "node:path";
import { ActivityLedger, TaskOccurrenceUnavailable } from "./activity-ledger.ts";
import { createActivityObserver } from "./activity-observer.ts";
import { daemonConfigFromEnv, type DaemonConfig } from "./config.ts";
import { controlKeyBlocksText, sendControlKey } from "./control-key.ts";
import { BROWSER_API_PREFIX, proxyBridgeRequest, proxyTargetUrl, type BridgeFetch } from "./bridge-proxy.ts";
import { approvePendingRequest, collectPendingRequests, PendingRequestStore } from "./requests.ts";
import { handleCooperationRequest, advanceCooperationTask } from "./task-cooperation-routes.ts";
import { CooperationConflict, InvalidCooperation } from "./task-cooperation.ts";
import { serveStatic, type StaticDir } from "./static.ts";
import { HerdrSocketClient } from "./herdr-client.ts";
import { handleMemoryRequest, isMemoryPath } from "./memory-routes.ts";
import { PersonaRegistry } from "./persona-registry.ts";
import {
  createEventObserver, createPersona, deletePersona, launchPersonaTask, listPersonas, recoverPersonas,
  memoryStoreOf, sendPersonaMessage, updatePersona, validatePersonaInput, validatePersonaPatch, type PersonaRuntime,
} from "./persona-service.ts";

import { createDaemonSystemAdmissions } from "./system-admission.ts";
import { SessionController } from "./session-controller.ts";
import { SessionLocked, lockedResponse, type MutationAdmission } from "./session-lock.ts";
import { loadUnlockVerifier } from "./unlock-credentials.ts";
import { handlePushRequest, type PushApiRuntime } from './push-api.ts';
import { initializePushRuntime, type PushDaemonRuntime } from './push-runtime.ts';
const pushRuntimes = new WeakMap<DaemonConfig, Promise<PushDaemonRuntime | null>>();

const sessionControllers = new WeakMap<DaemonConfig, SessionController>();
function sessionController(cfg: DaemonConfig): SessionController {
  let controller = sessionControllers.get(cfg);
  if (!controller) {
    controller = new SessionController({ devHttp: cfg.sessionDevHttp, verify: () => cfg.unlockDataDir ? loadUnlockVerifier(cfg.unlockDataDir) : null });
    sessionControllers.set(cfg, controller);
  }
  return controller;
}
function trustedSessionTransport(req: Request & { remoteAddress?: string | null }, cfg: DaemonConfig): boolean {
  if (cfg.sessionDevHttp) return isLoopbackRequest(req) && !req.headers.has("tailscale-user-login") &&
    req.headers.get("host") === `localhost:${cfg.port}` && new URL(req.url).origin === `http://localhost:${cfg.port}`;
  // Serve terminates HTTPS before the loopback HTTP hop. Only its fixed Host + trusted injected
  // identity + socket peer constitute this front door; arbitrary forwarded-proto headers do not.
  // Same-UID local processes can forge this tuple and are explicitly outside the lock boundary.
  const host = req.headers.get("host")?.toLowerCase();
  const expected = cfg.tailscaleHost.toLowerCase();
  const login = req.headers.get("tailscale-user-login");
  return !!expected && isLoopbackAddress(req.remoteAddress ?? null) &&
    (host === expected || host === `${expected}:443`) && !!login && cfg.trustedUsers.includes(login);
}
function mutationOriginAllowed(req: Request & { remoteAddress?: string | null }, cfg: DaemonConfig): boolean {
  if (!trustedSessionTransport(req, cfg)) return false;
  return cfg.sessionDevHttp ? req.headers.get("origin") === `http://localhost:${cfg.port}` : hasTailscaleOrigin(req, cfg);
}

export const API_HEALTH_PATH = "/lite/api/health";
export const API_REQUESTS_PATH = "/lite/api/requests";
export const API_PERSONA_PATH = "/lite/api/persona";

const personaRuntimes = new WeakMap<DaemonConfig, PersonaRuntime>();
function personaRuntime(cfg: DaemonConfig, fetcher: BridgeFetch): PersonaRuntime {
  let runtime = personaRuntimes.get(cfg);
  if (!runtime) {
    runtime = {
      cfg,
      fetcher,
      registry: new PersonaRegistry(cfg.registryPath),
      activity: new ActivityLedger(cfg.activityPath ?? join(dirname(cfg.registryPath), "activity.json")),
      herdr: new HerdrSocketClient({ socketPath: cfg.herdrSocketPath }),
    };
    personaRuntimes.set(cfg, runtime);
  }
  return runtime;
}

async function resolvePendingOwnership(runtime: PersonaRuntime, pane: PaneWire): Promise<{ personaId: string; taskOccurrenceKey?: string } | undefined> {
  const persona = (await runtime.registry.list()).find(item => item.spaceId === pane.workspaceId);
  if (!persona) return undefined;
  if (persona.mainPaneId === pane.paneId) return { personaId: persona.id };
  const task = await runtime.activity?.ownership(pane.paneId);
  return { personaId: persona.id, ...(task?.personaId === persona.id && task.spaceId === pane.workspaceId && task.paneId === pane.paneId ? { taskOccurrenceKey: task.occurrenceKey } : {}) };
}

function isPersonaWrite(pathname: string): boolean {
  return pathname === API_PERSONA_PATH || /^\/lite\/api\/persona\/[^/]+(?:\/message)?$/.test(pathname);
}

function jsonRequired(req: Request): boolean {
  const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

async function readJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}


const requestStores = new WeakMap<DaemonConfig, PendingRequestStore>();
function requestStore(cfg: DaemonConfig): PendingRequestStore {
  let store = requestStores.get(cfg);
  if (!store) {
    store = new PendingRequestStore();
    requestStores.set(cfg, store);
  }
  return store;
}

export function accessConfigOf(c: DaemonConfig): AccessConfig {
  return {
    trustedUsers: c.trustedUsers,
    allowAnyHost: c.allowAnyHost,
    tailscaleHost: c.tailscaleHost,
  };
}

export function staticDirOf(c: DaemonConfig): StaticDir {
  return { root: c.webDist, indexHtml: c.indexHtml };
}

function hasTailscaleOrigin(req: Request, cfg: DaemonConfig): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === new URL(`https://${cfg.tailscaleHost}`).origin &&
      !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export async function handleRequest(
  req: Request & { remoteAddress?: string | null },
  cfg: DaemonConfig,
  fetcher: BridgeFetch = fetch,
  runtimeOverride?: PersonaRuntime,
  sessionOverride?: SessionController,
  pushOverride?: PushApiRuntime,
): Promise<Response> {
  const denied = checkAccess(req, accessConfigOf(cfg));
  if (!denied.ok) {
    return new Response(`${denied.reason}\n`, {
      status: denied.reason === "identity required" || denied.reason === "identity not trusted" ? 401 : 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const { pathname } = new URL(req.url);
  const isMutation = req.method !== "GET" && req.method !== "HEAD";
  if (pathname === "/lite/api/session" && !trustedSessionTransport(req, cfg)) return new Response("trusted HTTPS session front door required\n", { status: 403 });
  if (isMutation && !mutationOriginAllowed(req, cfg)) {
    return new Response("cross-origin rejected\n", { status: 403 });
  }
  const sessions = sessionOverride ?? sessionController(cfg);
  const subject = req.headers.get("tailscale-user-login") ?? "local-operator";
  const sessionResponse = await sessions.handle(req, subject);
  if (sessionResponse) return sessionResponse;
  let admission: MutationAdmission | undefined;
  let dispatched = false;
  const sessionRefusal = () => dispatched ? Response.json({ ok: false, code: "session.interrupted", executed: true, textDelivered: null, deliveryUnknown: true, error: "Locked during an operation; reconcile before retrying" }, { status: 423, headers: { "cache-control": "no-store" } }) : lockedResponse();
  if (isMutation) {
    try {
      const admitted = sessions.admission(req, subject);
      admission = { assert: () => admitted.assert(), dispatch<T>(effect: () => T): T { return admitted.dispatch(() => { dispatched = true; return effect(); }); } };
    } catch { return lockedResponse(); }
  }
  if (pathname.startsWith('/lite/api/push/')) {
    try {
      const push = pushOverride ?? await pushRuntimes.get(cfg);
      if (!push) return Response.json({ error: 'Configure HOMELING_PUSH_SUBJECT and restart the daemon to enable notifications' }, { status: 503, headers: { 'cache-control': 'no-store' } });
      return await handlePushRequest(req, push, subject, admission) ?? new Response('not found', { status: 404 });
    } catch { return Response.json({ error: 'push unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
  }
  const upstreamFetch = fetcher;
  fetcher = (target, init) => {
    const method = init?.method ?? "GET";
    return method === "GET" || method === "HEAD" ? upstreamFetch(target, init) : admission!.dispatch(() => upstreamFetch(target, init));
  };
  const isBridgeWritePost = req.method === "POST" && (
    pathname === `${BROWSER_API_PREFIX}launch` || pathname === `${BROWSER_API_PREFIX}stt` || /^\/lite\/api\/pane\/[^/]+\/(reply|keys|stop|control-key)$/.test(pathname)
  );
  const isApprovalPost = req.method === "POST" && /^\/lite\/api\/requests\/[^/]+\/approve$/.test(pathname);
  const isPersonaWriteRequest = isPersonaWrite(pathname) && req.method !== "GET";
  if ((isBridgeWritePost || isApprovalPost || isPersonaWriteRequest) && !isLoopbackRequest(req) && !hasTailscaleOrigin(req, cfg)) {
    return new Response("cross-origin rejected\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (pathname === API_HEALTH_PATH || pathname === "/api/health") {
    return Response.json({ ok: true, service: "homeling-daemon" });
  }

  const runtime = runtimeOverride ?? personaRuntime(cfg, upstreamFetch);
  try {
    const cooperationResponse = await handleCooperationRequest(req, runtime, admission, upstreamFetch);
    if (cooperationResponse) return cooperationResponse;
  } catch (error) {
    if (error instanceof SessionLocked) return sessionRefusal();
    throw error;
  }
  const taskAction = pathname.match(/^\/lite\/api\/activity\/task\/([^/]+)\/(history|screen|reply|stop|control-key)$/);
  if (taskAction) {
    if (!runtime.activity) return Response.json({ error: "Activity unavailable" }, { status: 503 });
    const action = taskAction[2]!;
    const method = action === "history" || action === "screen" ? "GET" : "POST";
    if (req.method !== method) return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow: method } });
    if (method === "POST" && !jsonRequired(req)) return Response.json({ error: "application/json required" }, { status: 415 });
    const stale = () => Response.json({ ok: false, error: "Recorded task cannot be bound to this live pane", code: "task.occurrence_unavailable", executed: false, textDelivered: false, deliveryUnknown: false }, { status: 409, headers: { "cache-control": "no-store" } });
    try {
      const key = decodeURIComponent(taskAction[1]!);
      const occurrence = await runtime.activity.assertCurrent(key);
      const target = new URL(req.url);
      target.pathname = `/lite/api/pane/${encodeURIComponent(occurrence.paneId)}${action === "screen" ? "" : `/${action}`}`;
      if (action !== "history") target.search = "";
      const forwarded = new Request(target, req);
      let refused: unknown;
      const guardedFetch: BridgeFetch = (input, init) => {
        if (init?.method === "GET" || init?.method === "HEAD" || !init?.method) return upstreamFetch(input, init);
        return runtime.activity!.dispatchCurrent(key, admission!, (bound) => {
          if (bound.paneId !== occurrence.paneId) throw new TaskOccurrenceUnavailable();
          if (action === "reply" && controlKeyBlocksText(cfg, bound.paneId)) return Response.json({ ok: false, executed: false, textDelivered: false, deliveryUnknown: false, error: "Cancellation is in flight or unknown; inspect the terminal before sending text" }, { status: 409 });
          return upstreamFetch(input, init);
        }).catch((error) => { refused = error; throw error; });
      };
      const response = action === "control-key" ? await sendControlKey(forwarded, cfg, guardedFetch, requestStore(cfg)) : await proxyBridgeRequest(forwarded, cfg, guardedFetch);
      if (refused instanceof SessionLocked) return sessionRefusal();
      if (refused instanceof TaskOccurrenceUnavailable) return stale();
      if (method === "POST") return response;
      const body = await response.arrayBuffer();
      await runtime.activity.assertCurrent(key);
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
      if (error instanceof SessionLocked) return sessionRefusal();
      if (error instanceof TaskOccurrenceUnavailable) return stale();
      return Response.json({ error: "Task unavailable", code: "task.unavailable" }, { status: 502 });
    }
  }
  const activityMatch = pathname.match(/^\/lite\/api\/persona\/([^/]+)\/activity$/);
  const occurrenceMatch = pathname.match(/^\/lite\/api\/activity\/task\/([^/]+)$/);
  if (activityMatch || occurrenceMatch) {
    if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow: "GET" } });
    if (!runtime.activity) return Response.json({ error: "Activity unavailable" }, { status: 503 });
    try {
      if (activityMatch) {
        const id = decodeURIComponent(activityMatch[1]!);
        const activity = await runtime.activity.list(id);
        if (activity.occurrences.length === 0 && !await runtime.registry.get(id)) return Response.json({ error: "persona not found" }, { status: 404 });
        return Response.json(activity, { headers: { "cache-control": "no-store" } });
      }
      const key = decodeURIComponent(occurrenceMatch![1]!);
      const task = await runtime.activity.task(key);
      if (!task) return Response.json({ error: "task occurrence not found" }, { status: 404 });
      return Response.json(task, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return Response.json({ error: "Activity unavailable" }, { status: 502 });
    }
  }
  if (isMemoryPath(pathname)) {
    return (await handleMemoryRequest(req, { registry: runtime.registry, memory: memoryStoreOf(runtime) }, admission))!;
  }
  if (pathname === `${API_PERSONA_PATH}/list` && req.method === "GET") {
    try {
      return Response.json({ personas: await listPersonas(runtime) });
    } catch (error) {
      return Response.json({ error: "Herdr snapshot unavailable", code: safeErrorCode(error, "herdr.unavailable") }, { status: 502 });
    }
  }
  if (pathname === API_PERSONA_PATH && req.method === "POST") {
    if (!jsonRequired(req)) return Response.json({ error: "application/json required" }, { status: 415 });
    const input = validatePersonaInput(await readJson(req));
    if (!input) return Response.json({ error: "invalid persona" }, { status: 400 });
    try {
      const persona = await createPersona(runtime, input, req.headers.get("tailscale-user-login"), admission!);
      return Response.json({ persona: { ...persona, status: "active" } }, { status: 201 });
    } catch (error) {
      if (error instanceof SessionLocked) return sessionRefusal();
      return Response.json({ error: "Persona creation failed", code: safeErrorCode(error, "persona.create_failed") }, { status: 502 });
    }
  }
  const personaMessageMatch = pathname.match(/^\/lite\/api\/persona\/([^/]+)\/message$/);
  if (personaMessageMatch && req.method === "POST") {
    if (!jsonRequired(req)) return Response.json({ error: "application/json required" }, { status: 415 });
    const body = await readJson(req) as { text?: unknown } | null;
    if (!body || typeof body.text !== "string" || body.text.trim().length === 0 || body.text.length > 100_000) {
      return Response.json({ error: "text required" }, { status: 400 });
    }
    let id: string;
    try { id = decodeURIComponent(personaMessageMatch[1]!); } catch { return Response.json({ error: "invalid persona id" }, { status: 400 }); }
    try { return await sendPersonaMessage(runtime, id, body.text, req.headers.get("tailscale-user-login"), admission!); }
    catch (error) { return error instanceof SessionLocked ? sessionRefusal() : Response.json({ error: "Message delivery failed", code: "persona.message_failed" }, { status: 502 }); }
  }
  const personaMatch = pathname.match(/^\/lite\/api\/persona\/([^/]+)$/);
  if (personaMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    let id: string;
    try { id = decodeURIComponent(personaMatch[1]!); } catch { return Response.json({ error: "invalid persona id" }, { status: 400 }); }
    if (req.method === "PATCH") {
      if (!jsonRequired(req)) return Response.json({ error: "application/json required" }, { status: 415 });
      const patch = validatePersonaPatch(await readJson(req));
      if (!patch) return Response.json({ error: "invalid persona patch" }, { status: 400 });
      try {
        const persona = await updatePersona(runtime, id, patch, admission!);
        return persona ? Response.json({ persona }) : Response.json({ error: "persona not found" }, { status: 404 });
      } catch (error) { return error instanceof SessionLocked ? sessionRefusal() : Response.json({ error: "Persona update failed", code: "persona.update_failed" }, { status: 502 }); }
    }
    try {
      const result = await deletePersona(runtime, id, admission!);
      return result.deleted ? Response.json(result) : Response.json({ error: "persona not found" }, { status: 404 });
    } catch (error) { return error instanceof SessionLocked ? sessionRefusal() : Response.json({ error: "Persona delete failed", code: "persona.delete_failed" }, { status: 502 }); }
  }
  if (isPersonaWrite(pathname) && req.method !== "POST" && req.method !== "PATCH" && req.method !== "DELETE") {
    return new Response("method not allowed\\n", { status: 405, headers: { allow: "GET, POST, PATCH, DELETE" } });
  }

  const store = requestStore(cfg);
  const collectRequests = async () => {
    const cooperation = await runtime.activity?.cooperationPending() ?? [];
    try {
      const native = await collectPendingRequests(cfg, fetcher, store, req.headers.get('tailscale-user-login'),
        Date.now(), pane => resolvePendingOwnership(runtime, pane));
      return [...native, ...cooperation];
    } catch (error) {
      if (cooperation.length) return cooperation;
      throw error;
    }
  };
  if (req.method === "POST" && /^\/lite\/api\/pane\/[^/]+\/control-key$/.test(pathname)) {
    return sendControlKey(req, cfg, fetcher, store);
  }
  const taskRequestsMatch = pathname.match(/^\/lite\/api\/activity\/task\/([^/]+)\/requests$/);
  if (taskRequestsMatch) {
    if (req.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
    if (!runtime.activity) return Response.json({ error: 'Activity unavailable' }, { status: 503 });
    let key: string;
    try { key = decodeURIComponent(taskRequestsMatch[1]!); } catch { return Response.json({ error: 'invalid task occurrence' }, { status: 400 }); }
    try {
      const task = await runtime.activity.assertCurrent(key);
      const requests = await collectRequests();
      await runtime.activity.assertCurrent(key);
      return Response.json(requests.filter(item => item.paneId === task.paneId && item.taskOccurrenceKey === key), { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return Response.json({ error: 'Task occurrence is unavailable; inspect recorded activity', executed: false }, { status: error instanceof TaskOccurrenceUnavailable ? 409 : 502, headers: { 'cache-control': 'no-store' } });
    }
  }
  if (pathname === API_REQUESTS_PATH && req.method === "GET") {
    try {
      return Response.json(await collectRequests());
    } catch {
      return Response.json({ error: "bridge unavailable" }, { status: 502 });
    }
  }
  const approvalMatch = pathname.match(/^\/lite\/api\/requests\/([^/]+)\/approve$/);
  if (approvalMatch && req.method === "POST") {
    const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return new Response("application/json required\n", {
        status: 415,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    let body: { optionId?: unknown; occurrenceKey?: unknown; freeText?: unknown };
    try {
      body = await req.json() as { optionId?: unknown; occurrenceKey?: unknown; freeText?: unknown };
    } catch {
      return Response.json({ error: "bad body" }, { status: 400 });
    }
    if (typeof body.optionId !== "string" || body.optionId.length === 0) {
      return Response.json({ error: "optionId required" }, { status: 400 });
    }
    let id: string;
    try {
      id = decodeURIComponent(approvalMatch[1]!);
    } catch {
      return Response.json({ error: "invalid request id" }, { status: 400 });
    }
    if (id.startsWith("cooperation:")) {
      if (!runtime.activity) return Response.json({ error: "Activity unavailable" }, { status: 503 });
      if (body.occurrenceKey !== undefined && typeof body.occurrenceKey !== "string" ||
        body.freeText !== undefined && (typeof body.freeText !== "string" || body.freeText.length > 10000)) {
        return Response.json({ error: "invalid cooperation reply" }, { status: 400 });
      }
      try {
        const outcome = await runtime.activity.answerCooperationRequest(id, body.optionId,
          body.occurrenceKey as string | undefined, admission!, body.freeText as string | undefined);
        if (outcome.outcome === "submitted") {
          // 回复到达后重排，只派发当下仍满足条件的一步。
          try { await advanceCooperationTask(outcome.occurrenceKey, req, runtime, admission!, upstreamFetch); }
          catch { /* 回答已经持久化；派发异常由阶段状态和后续 advance 核查。 */ }
        }
        return Response.json(outcome, { status: outcome.status === "expired" ? 409 : 200 });
      } catch (error) {
        if (error instanceof SessionLocked) return sessionRefusal();
        return Response.json({ status: "expired", outcome: "stale", error: "Cooperation reply unavailable" },
          { status: error instanceof InvalidCooperation ? 400 : error instanceof TaskOccurrenceUnavailable || error instanceof CooperationConflict ? 409 : 502 });
      }
    }
    const record = store.find(id)?.request;
    if (body.occurrenceKey !== undefined && (typeof body.occurrenceKey !== 'string' || body.occurrenceKey !== record?.taskOccurrenceKey)) {
      return Response.json({ status: 'expired', outcome: 'stale', executed: false }, { status: 409 });
    }
    const taskKey = record?.taskOccurrenceKey;
    if (taskKey) {
      try {
        if (!runtime.activity || (await runtime.activity.assertCurrent(taskKey)).paneId !== record?.paneId) throw new TaskOccurrenceUnavailable();
      } catch { return Response.json({ status: 'expired', outcome: 'stale', executed: false }, { status: 409 }); }
    }
    let lockRejected = false;
    const approvalFetch: BridgeFetch = async (target, init) => {
      if ((init?.method ?? 'GET') === 'GET') return fetcher(target, init);
      try {
        if (!taskKey) return await fetcher(target, init);
        return await runtime.activity!.dispatchCurrent(taskKey, admission!, task => {
          const targetUrl = new URL(String(target));
          const expectedUrl = new URL(proxyTargetUrl(`/lite/api/pane/${encodeURIComponent(task.paneId)}/keys`, cfg, 'POST'));
          if (task.paneId !== record?.paneId || targetUrl.href !== expectedUrl.href || controlKeyBlocksText(cfg, task.paneId)) throw new TaskOccurrenceUnavailable();
          return upstreamFetch(target, init);
        });
      } catch (error) {
        if (error instanceof SessionLocked) {
          lockRejected = true;
          return Response.json({ ok: false, code: 'prompt.read_failed' }, { status: 423 });
        }
        if (error instanceof TaskOccurrenceUnavailable) return Response.json({ ok: false, code: 'prompt_changed' }, { status: 409 });
        throw error;
      }
    };
    const outcome = await approvePendingRequest(
      cfg, approvalFetch, store, id, body.optionId, Date.now(), req.headers.get("tailscale-user-login"),
    );
    if (lockRejected) return sessionRefusal();
    return Response.json(outcome, { status: outcome.status === "expired" ? 409 : 200 });
  }

  if (pathname === `${BROWSER_API_PREFIX}launch` && req.method === "POST") {
    const body = await req.clone().json().catch(() => null) as { personaId?: unknown; command?: unknown } | null;
    if (body && Object.hasOwn(body, "personaId")) {
      if (!jsonRequired(req)) return Response.json({ ok: false, error: "application/json required", code: "request.content_type" }, { status: 415 });
      if (typeof body.personaId !== "string" || typeof body.command !== "string") {
        return Response.json({ ok: false, error: "personaId and command required", code: "request.invalid" }, { status: 400 });
      }
      try { return await launchPersonaTask(runtime, body.personaId, body.command, req.headers.get("tailscale-user-login"), admission!); }
      catch (error) {
        if (error instanceof SessionLocked) return sessionRefusal();
        return Response.json({ ok: false, error: "Task launch failed", code: "launch.failed" }, { status: 502 });
      }
    }
  }

  if (pathname.startsWith(BROWSER_API_PREFIX)) {
    if (req.method === "POST" && !isBridgeWritePost) {
      return new Response("method not allowed\n", { status: 405, headers: { allow: "GET" } });
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, POST" } });
    }
    if (req.method === "POST" && /\/reply$/.test(pathname)) {
      let target: URL;
      try { target = new URL(proxyTargetUrl(pathname + new URL(req.url).search, cfg, "POST")); }
      catch { return new Response("not found\n", { status: 404 }); }
      if (controlKeyBlocksText(cfg, target.pathname.split("/")[3]!)) {
        return Response.json({ ok: false, textDelivered: false, error: "Cancellation is in flight or unknown; inspect the terminal before sending text" }, { status: 409 });
      }
    }
    try { return await proxyBridgeRequest(req, cfg, fetcher); }
    catch (error) { if (error instanceof SessionLocked) return sessionRefusal(); throw error; }
  }

  const staticRes = await serveStatic(req, staticDirOf(cfg));
  return staticRes ?? new Response("not found\n", { status: 404 });
}

export function startDaemon(cfg: DaemonConfig = daemonConfigFromEnv({})): ReturnType<typeof Bun.serve> {
  const fetch = (req: Request): Promise<Response> => {
    // Loopback trust comes from the peer address, not headers — read it from the server,
    // because `req.remoteAddress` is not populated on plain Bun.serve requests.
    const remoteAddress: string | null = server.requestIP(req)?.address ?? null;
    return handleRequest(Object.assign(req, { remoteAddress }), cfg);
  };
  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.hostname,
    fetch,
  });
  const runtime = personaRuntime(cfg, globalThis.fetch);
  const system = createDaemonSystemAdmissions();
  const push = initializePushRuntime(cfg, runtime, system).catch(() => {
    console.error('[homeling-daemon] independent push initialization failed');
    return null;
  });
  pushRuntimes.set(cfg, push);
  const activityObserver = createActivityObserver(runtime.activity!, runtime.herdr, system.activityObserve);
  runtime.observeTask = (paneId) => activityObserver.watch(paneId);
  void recoverPersonas(runtime, system.personaRecovery).catch((error: unknown) => {
    console.error(`[homeling-daemon] persona recovery unavailable: ${safeErrorCode(error, "persona.recovery_failed")}`);
  });
  createEventObserver(runtime, system.personaRecovery);
  console.log(`[homeling-daemon] listening on http://${cfg.hostname}:${cfg.port} serving ${cfg.webDist} at /lite/`);
  return server;
}

// Entrypoint when run directly (`bun run src/index.ts`); skipped under bun test.
if (import.meta.main && !process.env.BUN_TEST) {
  startDaemon();
}
